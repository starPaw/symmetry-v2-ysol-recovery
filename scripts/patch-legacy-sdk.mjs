import fs from "node:fs";
import path from "node:path";

const target = path.resolve(
  "node_modules/@symmetry-hq/funds-sdk/dist/utils.js"
);

if (!fs.existsSync(target)) {
  console.error("Legacy SDK utils.js not found:", target);
  process.exit(1);
}

const source = fs.readFileSync(target, "utf8");

const needles = [
  'let solanaTokenList = (yield axios_1.default.get("https://token.jup.ag/strict")).data;',
  "let solanaTokenList = (yield axios_1.default.get('https://token.jup.ag/strict')).data;"
];

if (source.includes("let solanaTokenList = [];")) {
  console.log("Legacy Jupiter token-list request is already patched.");
  process.exit(0);
}

let patched = source;

for (const needle of needles) {
  if (patched.includes(needle)) {
    patched = patched.replace(
      needle,
      "let solanaTokenList = [];"
    );
    break;
  }
}

if (patched === source) {
  console.error(
    [
      "Could not locate the obsolete token.jup.ag/strict request.",
      "The installed funds-sdk may differ from the tested 0.1.80 build.",
      "Refusing to modify the package automatically."
    ].join("\n")
  );
  process.exit(1);
}

fs.writeFileSync(
  target + ".bak",
  source,
  "utf8"
);

fs.writeFileSync(
  target,
  patched,
  "utf8"
);

console.log(
  "Patched @symmetry-hq/funds-sdk: disabled obsolete token.jup.ag/strict metadata request."
);
