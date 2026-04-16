import crypto from 'node:crypto';
import fs from 'node:fs';
import rl from 'node:readline/promises';
import process from 'node:process';
import { WebsocketProtocol } from './server.ts';
import { EventEmitter } from 'node:events';
import protobuf from 'google-protobuf';
import * as protocol from './protocol.ts';
const rl_interface = rl.createInterface(
	process.stdin,
	process.stdout,
	(line: string) => [[],line],
	true
);

if (!fs.existsSync('keys'))
	fs.mkdirSync('keys');
if (!fs.existsSync('keys/pub') ||
	!fs.existsSync('keys/priv')
) {
	console.log('keys not found, creating new key pair')
	// KeyPairExportOptions<"spki", "pkcs8">
	const key_pair = crypto.generateKeyPairSync('ed25519');
	// console.log(key_pair.privateKey, key_pair.publicKey);
	if (fs.existsSync('keys/pub'))
		fs.truncateSync('keys/pub');
	fs.writeFileSync('keys/pub', key_pair.publicKey.export({format: 'pem', type: 'spki'}));
	if (fs.existsSync('keys/priv'))
		fs.truncateSync('keys/priv');
	fs.writeFileSync('keys/priv', key_pair.privateKey.export({format: 'pem', type: 'pkcs8'}));
}

const private_key = crypto.createPrivateKey(fs.readFileSync('keys/priv').toString());
const public_key = crypto.createPublicKey(fs.readFileSync('keys/pub').toString());

/** blabber - the websocket/p2p part of jblabber */
class Blabber extends EventEmitter {
	socket: WebSocket;
	constructor(socket: WebSocket) {
		super();
		this.socket = socket;
		this.socket.addEventListener('open', () => {
			this.emit('open')
		})
		this.socket.addEventListener('close', () => {
			this.emit('close')
		})
		this.socket.addEventListener('error', () => {
			this.emit('error')
		})
		this.socket.addEventListener('message', (event) => {
			this.emit('message', event.data.toString())
			const json = JSON.parse(event.data.toString());
			if (!json.type) throw `malformed packet ${JSON.stringify(json)}`;
			if (json.type == 'DataReceive') {
				const packet = json as WebsocketProtocol.DataReceivePacket;
				this.emit('packet', {type: json.type, packet});
				this.emit(json.type, packet);
			} else {
				throw `unknown packet type ${json.type}`;
			}
		})
	}
	wait_for_packet(type: WebsocketProtocol.PacketType): Promise<WebsocketProtocol.Packet> {
		return new Promise((resolve) => {
			this.once(type, resolve)
		})
	}
}

/** jabber - the e2e/chat protocol part of jblabber */
class Jabber extends EventEmitter {
	blabber: Blabber;
	handle_poke() {}
	constructor(url: string = 'ws://localhost:2137') {
		super()
		this.blabber = new Blabber(new WebSocket(url));

	}
}

const ws = new WebSocket('ws://localhost:2137')
ws.addEventListener('message', async (event) => {
	if (typeof event.data === 'string')
		console.log(String(event.data))
	else
		console.log(await (event.data as Blob).bytes())
})
ws.addEventListener('open', (event) => {
	console.log('open')
})
ws.addEventListener('close', (event) => {
	console.log(`close ${event.code}`)
})
ws.addEventListener('error', (event) => {
	console.log('error')
})

rl_interface.on('SIGINT', () => {
	Deno.exit(0)
});
rl_interface.on('close', () => Deno.exit(0));
while (true) {
	const command = await rl_interface.question(': ')
	console.log(JSON.stringify(command))
	if (command == null || command == '/exit')
		Deno.exit(0);
	if (command == '/list') {
		const uh = protocol.ClientListRequestPacket.create();
		const fuckme = protocol.ClientListRequestPacket.toBinary(uh)
		ws.send(new Uint8Array([3, ...fuckme]))
	}
}
