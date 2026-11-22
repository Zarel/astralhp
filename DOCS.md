# Supported file types

To get started, this is an example webroot: [`example/`](example/).

Most files in your webroot will be served statically.

Exceptions include:

## `.astro`

AstralHP uses [the same `.astro` files as Astro](https://docs.astro.build/en/basics/astro-pages/#astro-pages).

The main difference is that AstralHP doesn't enforce the directory layout Astro
does; instead, it uses file extensions to distinguish between `src/pages/` and
`public/`.

The `.astro` extension will be left off of the served URL, and
`index.astro` will be served for directories. So, for instance, the live
routes will be:

- `index.astro` -> `http://example.com/`
- `foo.astro` -> `http://example.com/foo`
- `bar.html.astro` -> `http://example.com/bar.html`

## `.js`, `.css`, `.ts`, `.tsx`, `.scss`

These files will be served verbatim, if visited directly.

AstralHP supports Astro's usual ways to include CSS and JS, which process
them and put them in `http://example.com/_astro/` to be served.

If you would prefer a more PHP-style approach, we offer `<CSS>` and `<JS>`
components that keep the source file's URL path, changing the extension when
needed, and add a cachebuster. `<CSS>` serves plain CSS unchanged or compiles
SCSS; `<JS>` bundles JavaScript or TypeScript and its imports for modern
browsers.

```astro
---
import { CSS, JS } from "astralhp/components";
---
<CSS src="/style.css" />
<JS src="/js/app.tsx" defer />
```

`<CSS>` renders a `<link rel="stylesheet">` and `<JS>` renders a
`<script src>`. Both add a cachebuster based on hashed contents:

```html
<link rel="stylesheet" href="/style.css?v=0123456789abcdef">
<script type="module" src="/js/app.min.js?v=0123456789abcdef" defer></script>
```

The source can be absolute (relative to the webroot) or relative to the Astro
component:

```astro
<CSS src="/style/global.css" />
<CSS src="style.css" />
<CSS src="../shared.css" />
```

The resolved file must be inside the webroot. Missing files, existing queries,
fragments, and external URLs are errors.

For a `.ts`, `.tsx`, `.js`, or `.jsx` source, `<JS>` builds a bundled and
minified `.min.js` file, and also builds a corresponding `.min.js.map`
source map:

```astro
<JS src="script.tsx" />
```

```html
<script type="module" src="/script.min.js?v=0123456789abcdef"></script>
```

Add `inline` to put the compiled contents directly into a `<style>` or
`<script type="module">`:

```astro
<CSS src="/style.scss" inline />
<JS src="/js/app.ts" inline />
```

## `.md` and `.mdx` Markdown files

AstralHP supports
[Markdown](https://docs.astro.build/en/guides/markdown-content/)
and
[MDX](https://docs.astro.build/en/guides/integrations-guide/mdx/#using-components-in-mdx)
like in Astro, no additional installation needed.

We have two config settings, `markdownLayout` and `markdownAddTargetBlank`,
to make Markdown easier to use.

If no title is provided in frontmatter, it will be inferred from the first
heading, making it relatively easy to turn regular Markdown files into
pages.

## `.astro.ts` and `.astro.js` endpoints

AstralHP supports
[Astro endpoints](https://docs.astro.build/en/guides/endpoints/),
but because we put clientside and serverside TS/JS in the same webroot,
endpoints need to explicitly end with `.astro.ts` and `.astro.js`.

The `.astro.ts`/`.astro.js` part will be cut off of the served URL.

- `index.astro.ts` -> `http://example.com/`
- `foo.astro.ts` -> `http://example.com/foo`
- `bar.json.astro.ts` -> `http://example.com/bar.json`

## `.inc.astro`, `.inc.ts`, and `.inc.js` includes

You might want to use `.astro` and `.ts` for files that are only imported,
by other files, and not as actual publicly-accessible routes.

As a first resort, we recommend having an `includes` directory outside
your webroot.

As a second resort, we recommend having a `.includes` directory inside
your webroot.

As a last resort, add `.inc` so they're not treated as routes. Files ending
in `.inc.astro`, `.inc.ts`, and `.inc.js` can still be imported by endpoints
and `.astro` and `.mdx` files, but won't be published as routes.

## `.php`

PHP files do not get any special handling from AstralHP; a Node server will
serve them verbatim, and an Apache server will do whatever it's configured to
do, so if it's set up to serve PHP, PHP files will continue working as
normal, letting you mix `.php` and `.astro` files and migrate them one at a
time.

# Configuration

See [`src/config.d.ts`](src/config.d.ts) for config documentation.

# Advanced

## Cache directories

The build writes generated Astro files to `example/.caches/dist/`. The live
server serves those generated files alongside static files read directly from
the webroot. Dynamic pages are handled by Astro's Node adapter middleware from
`example/.caches/dist/.server/`. It never copies the webroot's static files.

AstralHP uses a few hidden cache directories:

```text
[project]/
  astralhp.mts
  .caches/
    .astro/
      vite/
  [webroot]/
    .caches/
      dist/
        _astro/
        .server/
      dev-dist/
```

- `.astro` contains Astro build metadata
- `.astro/vite` contains Vite build metadata
- `dev-dist` is a copy of dist used by the `astralhp dev` command
- `dist/_astro` contains Astro runtime dependencies (stuff like styles, scripts, images)
- `dist/.server` contains server software for dynamic pages
- `dist` contains built versions of static pages

AstralHP interprets the project directory as the directory containing
`astralhp.mts` or `package.json`. If neither exists, it uses the webroot.

We recommend not using the same directory for webroot and the project, but you
can do that by setting `webroot: '.'`. This combines the two `.caches/`
directories. With multiple webroots, `.astro` will be in
`.caches/[webroot]/.astro`.

You probably want to add `.caches/` to your `.gitignore`.

## ES3 and Babel

AstralHP supports compiling all the way down to ES3, for ancient browsers.
This approach uses Babel and compiles `import` and `export` to no-ops,
making everything a global.

When doing this, use `<ES3 src="script.tsx" />` for each module you use,
dependencies first. Unlike `<JS>`, there will be no bundling. We'll
scan for `<ES3>` and compile each source file to a `.js` file.

```text
example/
  script.tsx
example/.caches/dist/
  script.js
  script.js.map
```

This Babel configuration is designed to target ancient browsers while
still letting you write code that looks modern. If you don't care about
targeting ancient browsers, you're probably better off using `<JS>`
instead.

If you do care about targeting ancient browsers, keep in mind:

- We use Babel in loose mode, so make sure your code follows best practices
- We assume that all `for...of` is on arrays
- We assume that you only ever use `for...in` on bare objects, not arrays
  or primitives
- You can't use anything that doesn't compile down to ES3, such as
  async/await
- We don't polyfill Map/Set because we have no use for them, either

## `import.meta.dirname`

Normally, Vite's bundle process doesn't touch `import.meta.dirname` and
`import.meta.filename`, which changes them be the path of the bundle. AstralHP
rewrites it to be the location of the original file it was written in, which
may involve `..` directories.
