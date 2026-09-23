// The panel's webview script lives in a TS template literal, where an escape like \" silently
// becomes " and breaks the page at runtime (it just shows "Loading…"). Parse the exact script
// both views receive, so that fails the build instead.
const Module = require("module");
const path = require("path");
const fs = require("fs");

const load = Module._load;
Module._load = (req, ...rest) => (req === "vscode" ? { Disposable: class {}, Uri: { joinPath: () => ({}) } } : load(req, ...rest));

const file = path.join(__dirname, "..", "out", "panel.js");
const m = new Module(file);
m.filename = file;
m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.__renderHtml = renderHtml;", file);

const webview = { cspSource: "", asWebviewUri: () => "codicon.css" };
for (const inEditor of [false, true]) {
  const html = m.exports.__renderHtml(inEditor, webview, {});
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1];
  try {
    new Function(script);
  } catch (err) {
    console.error(`Webview script (${inEditor ? "config tab" : "sidebar"}) has a syntax error: ${err.message}`);
    process.exit(1);
  }
}
console.log("webview scripts OK");
