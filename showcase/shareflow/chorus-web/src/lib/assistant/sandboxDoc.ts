/**
 * The sandboxed preview document for `html` and `react` artifacts — #607 part 3.
 *
 * Both run model-written code, so both render in an iframe with `sandbox="allow-scripts"` and **never**
 * `allow-same-origin`: the document gets an opaque origin and cannot read this app's cookies, storage or DOM,
 * navigate the top window, open popups or submit forms. On top of that, this builder puts a strict
 * Content-Security-Policy `<meta>` at the very start of the document, so scripts and styles load only from an
 * allowlist of CDNs and the page can make no network request at all (`connect-src 'none'`).
 *
 * The meta is PREPENDED rather than spliced into the author's `<head>`: the HTML parser opens an implicit
 * `<head>` for it, and the author's own `<!doctype>`/`<html>`/`<head>` that follow are merged or ignored — so
 * the policy is in force before the first byte of model-written markup, whatever shape that markup has. An
 * author's own CSP meta can only add restrictions (every policy is enforced), never lift this one.
 *
 * `react`: the content is ONE component file with a default export. The document loads React 18, ReactDOM and
 * Babel standalone from cdnjs (pinned, with subresource integrity), plus the Tailwind browser build from
 * jsDelivr when the component uses `className`, transpiles the file and mounts its default export. A syntax
 * error, a failed import, a throw while rendering or a runtime that did not load is shown inside the frame.
 *
 * In a themed project the theme's `--t-*` variables are declared on `:root`, so a page can opt in to them.
 *
 * Pure, so the contract is tested (`__tests__/sandboxDoc.test.ts`).
 */
import type { ThemeVars } from './artifactTheme';

/** The iframe's sandbox. `allow-same-origin` must never be added — see the header. */
export const SANDBOX = 'allow-scripts';

export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  'font-src https://fonts.gstatic.com',
  'img-src data: blob: https:',
  "connect-src 'none'",
  "frame-src 'none'",
  // Neither falls back to default-src; both only tighten the policy asked for.
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

type CdnScript = { readonly src: string; readonly integrity: string };

/** Pinned, with SRI hashes computed from the files these URLs served on 2026-09-29. */
export const REACT_RUNTIME: readonly CdnScript[] = [
  { src: 'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js', integrity: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z' },
  { src: 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js', integrity: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1' },
  { src: 'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js', integrity: 'sha384-x/ilTFv/u/eu6YSmkFDZl5V5Mm/pkxxcVv2cVJOrr1J0rvILhMvRBCy6yA75wYBj' },
];

export const TAILWIND_RUNTIME: CdnScript = {
  src: 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.13/dist/index.global.js',
  integrity: 'sha384-P0V9YU7TFy919I0oVLXiqiUsdiJiaV+QKGysF4Lx+s901F1X9+zjFV0mc6pRKCKq',
};

const scriptTag = (s: CdnScript): string => `<script src="${s.src}" integrity="${s.integrity}" crossorigin="anonymous"></script>`;

/** `:root { --t-…: … }`, or nothing. A value that could break out of the rule is dropped, not escaped. */
export function themeRootCss(theme: ThemeVars | null | undefined): string {
  if (!theme) return '';
  const decls = Object.entries(theme)
    .filter(([name, value]) => /^--t-[a-z-]+$/.test(name) && typeof value === 'string' && !/[<>{};\\]/.test(value))
    .map(([name, value]) => `${name}:${value}`);
  return decls.length === 0 ? '' : `:root{${decls.join(';')}}`;
}

const head = (extraCss: string, theme: ThemeVars | null | undefined): string => {
  const css = themeRootCss(theme) + extraCss;
  return (
    '<!doctype html>' +
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">` +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    (css === '' ? '' : `<style>${css}</style>`)
  );
};

/** JSON for an inline script: `<` escaped so `</script>` or `<!--` in the source cannot end the element. */
const inlineJson = (value: string): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const REACT_CSS =
  'html,body{margin:0}' +
  'body{padding:16px;font-family:var(--t-font-body,system-ui,sans-serif);color:var(--t-text,CanvasText);background:var(--t-bg,Canvas)}' +
  '#chorus-error{margin:0;padding:12px;border:1px solid currentColor;border-radius:8px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;color:crimson}';

/** Runs in the frame: transpile, evaluate as a CommonJS module with only react/react-dom requirable, mount. */
const reactBootstrap = (source: string): string => `(function(){
var SOURCE=${inlineJson(source)};
var failed=false;
function fail(message){
  if(failed)return;failed=true;
  var box=document.createElement('pre');box.id='chorus-error';
  box.textContent='This component could not run:\\n'+message;
  var root=document.getElementById('root');root.textContent='';root.appendChild(box);
}
window.addEventListener('error',function(e){fail(e.message||String(e.error));});
window.addEventListener('unhandledrejection',function(e){fail(String(e.reason&&e.reason.message||e.reason));});
if(!window.React||!window.ReactDOM||!window.Babel){fail('The React runtime did not load — the CDN may be unreachable.');return;}
var code;
try{
  code=Babel.transform(SOURCE,{filename:'artifact.tsx',presets:[['typescript',{isTSX:true,allExtensions:true}],'react'],plugins:['transform-modules-commonjs']}).code;
}catch(e){fail(e.message);return;}
var modules={'react':React,'react-dom':ReactDOM,'react-dom/client':ReactDOM};
window.__chorusRequire=function(name){
  if(Object.prototype.hasOwnProperty.call(modules,name))return modules[name];
  throw new Error('Only react and react-dom can be imported here, not "'+name+'".');
};
window.__chorusModule={exports:{}};
var run=document.createElement('script');
run.textContent='(function(require,module,exports,React){'+code+'\\n})(window.__chorusRequire,window.__chorusModule,window.__chorusModule.exports,window.React);';
document.body.appendChild(run);
if(failed)return;
var exported=window.__chorusModule.exports;
var App=exported&&(exported.__esModule||exported.default?exported.default:exported);
if(typeof App!=='function'&&!(App&&typeof App==='object'&&App.$$typeof)){fail('The file has no default export — end it with "export default function App() { … }".');return;}
function Boundary(props){React.Component.call(this,props);this.state={error:null};}
Boundary.prototype=Object.create(React.Component.prototype);
Boundary.prototype.constructor=Boundary;
Boundary.getDerivedStateFromError=function(error){return{error:error};};
Boundary.prototype.render=function(){
  if(this.state.error)return React.createElement('pre',{id:'chorus-error'},'This component failed while rendering:\\n'+(this.state.error&&this.state.error.message||String(this.state.error)));
  return this.props.children;
};
try{ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Boundary,null,React.createElement(App)));}
catch(e){fail(e.message);}
})();`;

export type SandboxKind = 'html' | 'react';

/** The `srcdoc` for an html or react artifact: CSP first, then the theme, then the content. */
export function buildSandboxDoc(input: { kind: SandboxKind; content: string; theme?: ThemeVars | null }): string {
  if (input.kind === 'html') return head('', input.theme) + input.content;
  const tailwind = /\bclassName\s*=/.test(input.content) ? scriptTag(TAILWIND_RUNTIME) : '';
  return (
    head(REACT_CSS, input.theme) +
    REACT_RUNTIME.map(scriptTag).join('') +
    tailwind +
    '<body><div id="root"></div>' +
    `<script>${reactBootstrap(input.content)}</script>` +
    '</body>'
  );
}

/**
 * An svg artifact as an `<img>` source. An image context runs no script and loads nothing external, whatever
 * the markup says — the agent service sanitizes it on write as well (`shareflow/src/design/svg.ts`).
 */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
