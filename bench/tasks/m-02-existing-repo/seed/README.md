# unitctl

Tiny dependency-free unit conversion CLI.

## Usage

```
node cli.js list
node cli.js convert 10 meters feet
```

## Supported conversions

| From       | To         |
| ---------- | ---------- |
| meters     | feet       |
| feet       | meters     |
| kilometers | miles      |
| miles      | kilometers |
| kilograms  | pounds     |
| pounds     | kilograms  |
| grams      | ounces     |
| ounces     | grams      |

## Tests

```
node --test
```
