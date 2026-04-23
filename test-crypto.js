import crypto from 'node:crypto'
import fs from 'node:fs'
console.log(fs.readFileSync(import.meta.filename).toString())
console.log(process.versions.openssl)
const key_pair = crypto.generateKeyPairSync('rsa', {
	modulusLength: 512
});
console.log(crypto.publicEncrypt(key_pair.publicKey, 'test'));