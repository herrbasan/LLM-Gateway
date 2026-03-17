import { ModelRouter } from './src/core/model-router.js';
import fs from 'fs';

const config = JSON.parse(fs.readFileSync('./config.json'));
const router = new ModelRouter(config);

async function run() {
   const modelConfig = router.registry.resolveModel('lmstudio-chat', 'chat').config;
   const adapter = router._getAdapter(modelConfig.adapter);
   const { context } = await router._handleContextCompaction(
       [{role: 'user', content: 'hello'}],
       modelConfig,
       adapter
   );
   console.log("Returned context:", context);
}
run().catch(console.error);
