import { Conversation } from './WebAdmin/public/chat/js/conversation.js';
global.localStorage = { getItem: () => null, setItem: () => {} };
let conv = new Conversation('test');
conv.addExchange('Hello');
let id = conv.exchanges[0].id;
console.log('init: ', conv.exchanges[0].assistant.versions);

conv.updateAssistantResponse(id, 'gen1');
conv.setAssistantComplete(id);
console.log('1st completion: ', conv.exchanges[0].assistant.versions);

conv.regenerateResponse(id);
console.log('after regen: ', conv.exchanges[0].assistant.versions);

conv.updateAssistantResponse(id, 'gen2');
conv.setAssistantComplete(id);
console.log('2nd completion: ', conv.exchanges[0].assistant.versions);

console.log(conv.getVersionInfo(id));
