
import fs from 'node:fs';
import rl from 'node:readline/promises';
import process from 'node:process';
import path from "node:path";
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Jabber, Message } from './jabber.ts';

const flags: Record<string, string> = {};
let i = 0;
while (i < process.argv.length) {
	if (process.argv[i].startsWith('--')) {
		flags[process.argv[i].slice(2)] = process.argv[++i]
	} else if (process.argv[i].startsWith('-')) {
		const uh = process.argv[i].slice(1).split('');
		const value = process.argv[++i];
		for (const key of uh)
			flags[key] = value;
	} else flags._ = process.argv[i]
	i++
}

function attachEELogger(ee:EventEmitter, label?: string) {
	const emit = ee.emit;
	ee.emit = function name(eventName: string | symbol, ...args: unknown[]) {
		console.log(`[${label??''}] emit`, eventName, ...args);
		return emit.call(this, eventName, ...args);
	}
}

const rl_interface = rl.createInterface(
	process.stdin,
	process.stdout,
	(line: string) => [[],line],
	true
);

if (!fs.existsSync('profile'))
	fs.mkdirSync('profile');
if (!fs.existsSync('profile/contacts'))
	fs.mkdirSync('profile/contacts');
if (!fs.existsSync('profile/contacts.json'))
	fs.writeFileSync('profile/contacts.json', '{}');
if (!fs.existsSync('profile/pub_key') ||
	!fs.existsSync('profile/priv_key')
) {
	console.log('keys not found, creating new key pair')
	// KeyPairExportOptions<"spki", "pkcs8">
	const key_pair = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048
	});
	console.log(crypto.publicEncrypt(key_pair.publicKey, 'test'));
	if (fs.existsSync('profile/pub_key'))
		fs.truncateSync('profile/pub_key');
	fs.writeFileSync('profile/pub_key', key_pair.publicKey.export({format: 'pem', type: 'spki'}));
	if (fs.existsSync('profile/priv_key'))
		fs.truncateSync('profile/priv_key');
	fs.writeFileSync('profile/priv_key', key_pair.privateKey.export({format: 'pem', type: 'pkcs8'}));
}
if (!fs.existsSync('profile/username')) {
	console.log('username not found, enter username')
	const username = await rl_interface.question('?');
	if (!username)
		throw new Error('you have to enter a username, bud');
	if (!Jabber.prototype.username_valid(username))
		throw new Error('invalid username');
	fs.writeFileSync('profile/username', username);
}

const private_key = crypto.createPrivateKey(fs.readFileSync('profile/priv_key').toString());
const public_key = crypto.createPublicKey(fs.readFileSync('profile/pub_key').toString());

if (
	private_key.asymmetricKeyType !== 'rsa' ||
	public_key.asymmetricKeyType !== 'rsa'
) {
	console.warn('ya keys are fucked mate, restart the pogram to generate new wuns');
	fs.rmSync('profile/priv_key')
	fs.rmSync('profile/pub_key')
	process.exit(1)
}

const username = fs.readFileSync('profile/username').toString()

const contact_db: Record<string,string> = JSON.parse(fs.readFileSync('profile/contacts.json').toString())
const jabber = new Jabber(flags.a ?? flags.address ?? 'ws://localhost:2137', username, public_key, private_key);

function sync_db() {
	fs.writeFileSync('profile/contacts.json', JSON.stringify(contact_db));
}

jabber.on('new_contact', contact => {
	const this_uuid = crypto.randomUUID();
	const identifier = `${contact.username}$${Buffer.from(contact.key_hash).toString('hex')}`;
	contact_db[identifier] = this_uuid;
	const contact_dir = path.join('profile/contacts', this_uuid)
	if (fs.existsSync(contact_dir))
		fs.rmSync(contact_dir, {recursive:true});
	fs.mkdirSync(contact_dir);
	// fs.writeFileSync(path.join(contact_dir, 'pub_key_hash'), contact.key_hash)
	fs.writeFileSync(path.join(contact_dir, 'messages.json'), '[]');
	sync_db();
})
jabber.on('handshake_complete', contact => {
	const identifier = `${contact.username}$${Buffer.from(contact.key_hash).toString('hex')}`;
	const this_uuid = contact_db[identifier];
	if (!this_uuid)
		throw 'uhhhhhh'
	const contact_dir = path.join('profile/contacts', this_uuid)
	if (!fs.existsSync(contact_dir))
		throw 'invalid state: contact dir does not exist';
	fs.writeFileSync(path.join(contact_dir, 'pub_key'), contact.key!.export({
		format: 'pem',
		type: 'spki'
	}))
})
jabber.on('message_received', (message, contact) => {
	const contents = jabber.td.decode(message);
	const message_object: Message = {
		contents,
		author: contact.username,
		date: Date.now()
	};
	console.log(`${contact.username}: ${contents}`);
	const identifier = `${contact.username}$${Buffer.from(contact.key_hash).toString('hex')}`;
	const this_uuid = contact_db[identifier];
	if (!this_uuid)
		throw 'uhhhhhh'
	const contact_dir = path.join('profile/contacts', this_uuid)
	if (!fs.existsSync(contact_dir))
		throw 'invalid state: contact dir does not exist';
	const messages = JSON.parse(fs.readFileSync(path.join(contact_dir, 'messages.json')).toString());
	messages.push(message_object);
	fs.writeFileSync(path.join(contact_dir, 'messages.json'), JSON.stringify(messages));
})

if (process.argv.includes('-d')) {
	attachEELogger(jabber, 'jabber')
	attachEELogger(jabber.blabber, 'blabber')
}

// const fs_contacts = fs.readdirSync('profile/contacts');

for (const identifier in contact_db) {
	if (!Object.hasOwn(contact_db, identifier)) continue;
	const contact_uuid = contact_db[identifier];
	const [username, key_hash_string] = identifier.split('$')
	// console.log(key_hash_string, identifier)
	const key_hash = Jabber.buffer_to_uint8array(Buffer.from(key_hash_string, 'hex'));
	const key = fs.existsSync(path.join('profile/contacts', contact_uuid, 'pub_key')) ?
		fs.readFileSync(path.join('profile/contacts', contact_uuid, 'pub_key')) :
		null;
	const messages = JSON.parse(fs.readFileSync(path.join('profile/contacts', contact_uuid, 'messages.json')).toString());
	jabber.contact_list.set(identifier, {
		username,
		client_id: -1,
		handshake_complete: key !== null,
		key_hash,
		messages,
		key: key ? crypto.createPublicKey({
			format: 'pem',
			type: 'spki',
			key
		}) : undefined
	});
}

rl_interface.on('SIGINT', () => {
	process.exit(0)
});
rl_interface.on('close', () => process.exit(0));
while (true) {
	const input = await rl_interface.question(': ')
	// console.log(JSON.stringify(input))
	const [command, ...args] = input.split(' ')
	if (input == null || input == '/exit') {
		// ws.close();
		jabber.blabber.socket.close()
		break
	} else if (input == '/list') {
		console.log(jabber.contact_list.entries().map(([id, contact]) => `\
${id}
	username: ${contact.username}
	key hash: ${Buffer.from(contact.key_hash).toString('hex')}
	handshake complete? ${contact.handshake_complete ? 'yes' : 'no'}`).toArray().join('\n'))
		continue
	} else if (command === '/handshake') {
		let contact = jabber.contact_list.get(args[0]);
		if (!contact) {
			const contacts = jabber.contact_list.keys().filter(k => k.includes(args[0])).toArray()
			if (contacts.length === 1) {
				contact = jabber.contact_list.get(contacts[0]);
			}
		}
		if (!contact) {
			console.error('not found')
			continue
		}
		await jabber.initiate_handshake(contact)
		console.log('ok')
		continue;
	} else if (command === '/msg') {
		let contact = jabber.contact_list.get(args[0]);
		if (!contact) {
			const contacts = jabber.contact_list.keys().filter(k => k.includes(args[0])).toArray()
			if (contacts.length === 1) {
				contact = jabber.contact_list.get(contacts[0]);
			}
		}
		if (!contact) {
			console.error('not found')
			continue
		}
		jabber.send_message_to(contact, args.slice(1).join(' '));
		console.log('ok')
		continue;
	}
}
