const express = require("express");

const app = express();
app.use(express.json());

const todos = [
  { id: 1, title: "Buy milk", done: false },
  { id: 2, title: "Write report", done: true },
];

app.get("/todos", (req, res) => {
  res.json(todos);
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`listening on ${port}`));
}

module.exports = { app, todos };
