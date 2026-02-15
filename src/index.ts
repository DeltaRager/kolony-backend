import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();
app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Kolony backend listening on port ${config.PORT}`);
});
