const { createApp } = require("./app");
const app = createApp({ apiKeys: (process.env.API_KEYS || "dev").split(","), dataFile: process.env.DATA_FILE });
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
