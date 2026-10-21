function createStore() {
  const items = [];
  let nextId = 1;
  return {
    all: () => items,
    add(item) {
      const created = { id: nextId++, ...item };
      items.push(created);
      return created;
    },
  };
}

module.exports = { createStore };
