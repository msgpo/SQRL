{
"use strict";
let localSodium = null, IMK = null, textualIdentity = null, sodiumLoadQueue = [];
window.sodium = { onload: sod => {
	localSodium = sod;
	for (func of sodiumLoadQueue)
	{
		func();
	}
	sodiumLoadQueue = [];
}};



function parseBlockType2(data)
{
	if (data.constructor === Uint8Array && data.length === 73)
	{
		let blockType = ab2int(data.slice(2, 4));
		if (blockType == 2)
			return {
				"enscryptSalt": data.slice(4, 20),
				"enscryptLogN": ab2int(data.slice(20, 21)),
				"enscryptIter": ab2int(data.slice(21, 25)),
				"dataToDecrypt": data.slice(25, 73),
				"additionalData": data.slice(0, 25)
			}
		else
			throw new Error('Argument 1 "data" should be a type 2 identity data block');
	}
	else
		throw new Error('Argument 1 "data" should be a Uint8Array of length 73');
}
function getPostDataAsync(href, sendResponse)
{
	if (typeof href == "string" && href.startsWith("sqrl://"))
	{
		let hurl = new URL(href.replace(/^sqrl:/, 'https:'));
		if (hurl != null && isValidHostname(hurl.hostname))
		{
			if (IMK == null)
			{
				sendResponse({"success": false, "errorCode": "ERRPD003"});
				return true;
			}
			else
			{
				var work = (href, hurl) => {
					let HMAC256Hash = localSodium.crypto_auth_hmacsha256(hurl.hostname, IMK);

					let { publicKey: SitePublicKey,  privateKey: SitePrivateKey } = localSodium.crypto_sign_seed_keypair(HMAC256Hash);
					memzero(HMAC256Hash);

					let client = base64url_encode([
						"ver=1",
						"cmd=ident",
						"idk=" + localSodium.to_base64(SitePublicKey),
						"opt=cps",
						"" //keep this empty string for trailing \r\n
					].join("\r\n"));
					memzero(SitePublicKey);

					let server = base64url_encode(href);
					let ids = localSodium.crypto_sign_detached(client + server, SitePrivateKey, 'base64');
					memzero(SitePrivateKey);

					sendResponse({"success": true, "postData": ["client=" + encodeURIComponent(client), "server=" + encodeURIComponent(server), "ids=" + encodeURIComponent(ids)].join('&')});
				};
				if (localSodium == null) //Fennec
				{
					sodiumLoadQueue.push(function(){
						work(href, hurl);
					});
					return false;
				}
				else
				{
					work(href, hurl);
					return true;
				}
			}
		}
		else
		{
			sendResponse({"success": false, "errorCode": "ERRPD002"});
			return true;
		}
	}
	else
	{
		sendResponse({"success": false, "errorCode": "ERRPD001"});
		return true;
	}
}
function importIdentity(ti, rescueCode, sendResponse)
{
	//FIXME: check that length of textual identity corresponds to a valid type2 or type2+type3 block
	// ... the following pre-calculated fixed character counts may be used: 107, 185, 232, 278, 325 for the five possible textual identity lengths (spaces and newlines removed).
	let validationResult = validateTextualIdentity(ti); //will also return success == true if the textual identity is only partly entered!
	if (validationResult.success)
	{
		let identityData = base56decode(ti.replace(/[\t ]/g,'').replace(/.(\r?\n|$)/g, "")).toArrayLike(Uint8Array).reverse();
		//console.log("identityData", JSON.stringify(Array.from(identityData)), identityData.length);
		let blockSize = ab2int(identityData.slice(0, 2));
		let blockType = ab2int(identityData.slice(2, 4));
		if (blockType == 2)
		{
			textualIdentity = ti;
			chrome.storage.local.set({"textualIdentity": ti});
			let extractedBlock2 = parseBlockType2(identityData.slice(0, blockSize));
			//console.log("extractedBlock2", extractedBlock2);
			//console.log("rescueCode", JSON.stringify(Array.from(rescueCode)), rescueCode.length);
			enscrypt(localSodium.crypto_pwhash_scryptsalsa208sha256_ll, str2ab(rescueCode.replace(/[^0-9]/g, "")), extractedBlock2.enscryptSalt, extractedBlock2.enscryptIter, (step, max) => {
				chrome.runtime.sendMessage({'action': 'enscryptUpdate', "step": step, "max": max}, result => {/* do nothing */});
			}).then(enscryptedPwd => {
				//console.log("enscryptedPwd", JSON.stringify(Array.from(enscryptedPwd)));
				aesGcmDecrypt(extractedBlock2.dataToDecrypt, extractedBlock2.additionalData, enscryptedPwd, new Uint8Array(12)).then(decrypted => {
					let IUK = new Uint8Array(decrypted);
					//console.log("IUK", IUK);
					IMK = enhash(localSodium, IUK);
					//FIXME: encrypt IMK with password
					chrome.storage.local.set({"IMK": Array.from(IMK)});
					sendResponse({"success": true, "name": ab2hex(localSodium.crypto_hash_sha256(IMK)).substr(0,8)});
				}).catch(err => {
					sendResponse({"success": false, "errorCode": "ERRII002"});
				});
			});
		}
		else
			return "ERRII001";
	}
	else
	{
		return "ERRII000";
	}
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	/* for content.js */
	if (request.action === "getPostData")
	{
		let hasCalledSendresponse = getPostDataAsync(request.href, sendResponse);
		if (!hasCalledSendresponse)
			return true; // make asynchronous
		/*
		let result = getPostData(request.href);
		sendResponse(result);
		chrome.browserAction.setBadgeText({"text": result.success ? "" : "Error", "tabId": sender.tab.id});
		*/
	}
	/* for popup.js */
	//FIXME: find a way to make sure these requests are not coming from content.js but from popup.js
	else if (request.action === "hasIdentity")
	{
		if (IMK == null)
		{
			sendResponse({"hasIdentity": false});
		}
		else
		{
			crypto.subtle.digest('SHA-256', IMK).then(sha256result => {
				sendResponse({"hasIdentity": true, "name": ab2hex(sha256result).substr(0,8), "textualIdentity": textualIdentity});
			});
			return true;
		}
	}
	else if (request.action === "eraseIdentity")
	{
		IMK = null;
		chrome.storage.local.remove(["IMK","identityDataType2"], () => {
			sendResponse(chrome.runtime.lastError);
		});
		return true;
	}
	else if (request.action === "importIdentity")
	{
		let errorCode = importIdentity(request.textualIdentity, request.rescueCode, sendResponse);
		if (errorCode)
			sendResponse({"success": false, "errorCode": errorCode });
		else
			return true; // so importIdentity() can use sendResponse() asynchronously
	}
	else
		console.warn("background request action not recognised", request.action);
});

chrome.storage.local.get(["IMK", "textualIdentity"], function(result){
	if (result.IMK)
	{
		IMK = new Uint8Array(result.IMK);
		memzero(result.IMK);
	}
	if (result.textualIdentity)
	{
		textualIdentity = result.textualIdentity;
	}
});
/*
var scrpt = document.createElement("script");
scrpt.setAttribute("src", "sodium-asmjs.js");
document.getElementsByTagName('head')[0].appendChild(scrpt);
*/
}
