const ROOT = new URL("../", import.meta.url);
const OUTPUT = new URL("../docs/", import.meta.url);

const copies = [
  ["pages-src/index.html", "index.html"],
  ["pages-src/site.css", "assets/site.css"],
  ["sample-site/index.html", "sample/index.html"],
  ["sample-site/article.html", "sample/article.html"],
  ["sample-site/about.html", "sample/about.html"],
  ["sample-site/subscribed.html", "sample/subscribed.html"],
  ["evidence/01-dom-before.png", "evidence/01-dom-before.png"],
  ["evidence/02-dom-after.png", "evidence/02-dom-after.png"],
  ["evidence/03-navigation-after.png", "evidence/03-navigation-after.png"],
  ["evidence/04-form-before.png", "evidence/04-form-before.png"],
  ["evidence/05-form-after.png", "evidence/05-form-after.png"],
  ["evidence/06-voice-before.png", "evidence/06-voice-before.png"],
  ["evidence/07-voice-after.png", "evidence/07-voice-after.png"],
] as const;

await Deno.remove(OUTPUT, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});

for (const [source, destination] of copies) {
  const sourceUrl = new URL(source, ROOT);
  const destinationUrl = new URL(destination, OUTPUT);
  await Deno.mkdir(new URL("./", destinationUrl), { recursive: true });
  await Deno.copyFile(sourceUrl, destinationUrl);
}

await Deno.writeTextFile(new URL(".nojekyll", OUTPUT), "");
console.log(`Built docs/ with ${copies.length + 1} deterministic files.`);
