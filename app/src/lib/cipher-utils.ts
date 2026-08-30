import CryptoJS from 'crypto-js';

export function encrypt(value: string, secret: string): string {
	const encrypted = CryptoJS.AES.encrypt(value, secret);
	const encryptedString = encrypted.toString();
	return encryptedString;
}

export function decrypt(encryptedString: string, secret: string): string {
	const decrypted = CryptoJS.AES.decrypt(encryptedString, secret);
	const decryptedString = decrypted.toString(CryptoJS.enc.Utf8);
	return decryptedString;
}
