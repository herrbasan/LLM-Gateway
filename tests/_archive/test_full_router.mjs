import { ModelRouter } from './src/core/model-router.js';
import fs from 'fs';
const config = JSON.parse(fs.readFileSync('./config.json'));
const router = new ModelRouter(config);

async function run() {
   const req = {
       model: 'lmstudio-chat',
       stream: true,
       messages: [{role: 'user', content: 'hello'}]
   };
   const res = await router.routeChatCompletion(req);
   console.log("KEYS returned from routeChatCompletion:", Object.keys(res));
   console.log("CONTEXT:", res.context);
}
run().catch(console.error);
