import crypto from 'node:crypto';
import fs from 'node:fs';
import rl from 'node:readline/promises';
import process from 'node:process';
import { BlabberPacket, PacketDataMap, PacketType } from './blabber.ts';
import { EventEmitter } from 'node:events';
import * as protocol from './blabber_protocol.ts';
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

const te = new TextEncoder()
const PACKET_SIGNATURE = te.encode('JABR')

/** blabber - the websocket/p2p part of jblabber */
class BlabberClient extends EventEmitter {
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
		this.socket.addEventListener('message', async (event) => {
			if (typeof event.data === 'string')
				return;
			
			const bytes = await (event.data as Blob).bytes();
			// if (bytes[0] && bytes.slice(0, 3).every((v, i) => []))
			const packet = BlabberPacket.deserialize(bytes);
			this.emit('packet$'+packet.kind, packet);
			this.emit('packet', packet);
			this.emit(packet.message_class.typeName, packet);
		})
	}
	wait_for_packet(type: PacketType): Promise<BlabberPacket<PacketType>> {
		return new Promise((resolve) => {
			this.once(`packet$${type}`, resolve)
		})
	}
	send_packet<T extends PacketType>(kind: PacketType, data: PacketDataMap[T]) {
		const packet = new BlabberPacket(kind);
		packet.protobuf_message = data;
		this.socket.send(packet.serialize())
	}
}

/** jabber - the e2ee/chat protocol part of jblabber */
class Jabber extends EventEmitter {
	blabber: BlabberClient;
	handle_poke() {}
	constructor(url: string = 'ws://localhost:2137') {
		super()
		this.blabber = new BlabberClient(new WebSocket(url));

	}
}

const ws = new WebSocket('ws://localhost:2137')
ws.addEventListener('message', async (event) => {
	if (typeof event.data === 'string')
		console.log(String(event.data))
	else {
		const bytes = await (event.data as Blob).bytes();
		const packet = BlabberPacket.deserialize(bytes);
		console.log(packet.kind, packet.message_class.typeName, packet.protobuf_message)
	}
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
	process.exit(0)
});
rl_interface.on('close', () => process.exit(0));
while (true) {
	const command = await rl_interface.question(': ')
	console.log(JSON.stringify(command))
	if (command == null || command == '/exit') {
		ws.close();
		break
	} else if (command == '/list') {
		const uh = protocol.ClientListRequestPacket.create();
		const fuckme = protocol.ClientListRequestPacket.toBinary(uh)
		ws.send(new Uint8Array([3, ...fuckme]))
	}
}
