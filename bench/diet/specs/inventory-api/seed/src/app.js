const express = require("express");
const { createStore } = require("./store");

function createApp(options = {}) {
  const store = createStore(options);
  const app = express();
  app.use(express.json());

  app.get("/items", (req, res) => {
    res.json(store.all());
  });

  return app;
}

module.exports = { createApp };
