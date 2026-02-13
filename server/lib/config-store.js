const fs = require('fs/promises');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'config.json');

async function readConfig() {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = {
  async get(key) {
    const config = await readConfig();
    return config[key];
  },

  async set(key, value) {
    const config = await readConfig();
    config[key] = value;
    await writeConfig(config);
  },

  async getAll() {
    return readConfig();
  }
};
