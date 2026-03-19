import { Conversation } from '../WebAdmin/public/chat/js/conversation.js';

global.localStorage = { getItem: () => null, setItem: () => {} };

const conversation = new Conversation('test');
conversation.addExchange('Hello');

const exchangeId = conversation.exchanges[0].id;

console.log('init: ', conversation.exchanges[0].assistant.versions);

conversation.updateAssistantResponse(exchangeId, 'gen1');
conversation.setAssistantComplete(exchangeId);
console.log('1st completion: ', conversation.exchanges[0].assistant.versions);

conversation.regenerateResponse(exchangeId);
console.log('after regen: ', conversation.exchanges[0].assistant.versions);

conversation.updateAssistantResponse(exchangeId, 'gen2');
conversation.setAssistantComplete(exchangeId);
console.log('2nd completion: ', conversation.exchanges[0].assistant.versions);

console.log(conversation.getVersionInfo(exchangeId));