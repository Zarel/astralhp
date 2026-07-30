# AstroHP

AstroHP is intended to make Astro work more like Apache+PHP, with a webroot
containing `.astro` pages and static files.

To run a dev server with `example` as the web root:

```sh
astrohp dev example
```

Files starting with `.astro` are rendered by Astro. Other files are served
statically.

To build and run a live server:

```sh
astrohp build example
astrohp start example
```

The build writes generated Astro files to `caches/[webroot]/build/`. The live
server serves those generated files alongside static files read directly from
the webroot. It never copies the webroot's static files.

The live server listens on `127.0.0.1:4321` by default. Set the `HOST` or
`PORT` environment variables to override either value.

## Components

AstroHP supports Astro's usual ways to include CSS and JS, but if you would
prefer a more PHP-style approach, we offer `<CSS>` and `<JS>` components
that cachebust an asset while leaving it unmodified and in the same location.

```astro
---
import { CSS, JS } from "astrohp/components";
---
<CSS src="/style.css" />
<JS src="/js/app.tsx" defer />
```

`<CSS>` renders a `<link rel="stylesheet">` and `<JS>` renders an inline
`<script src>`. Both forward additional attributes and append the local file's
modification time encoded in base 36:

```html
<link rel="stylesheet" href="/style.css?loyw3v28">
<script src="/js/app.js?loyw3v28" defer></script>
```

The source can be root-relative or relative to the rendered page:

```astro
<CSS src="/style/global.css" />
<CSS src="style.css" />
<CSS src="../shared.css" />
```

The resolved file must be inside the webroot. Missing files, existing queries,
fragments, and external URLs are errors.

For a `.ts` or `.tsx` source, `<JS>` changes the rendered extension to `.js`:

```astro
<JS src="script.tsx" />
```

```html
<script src="script.js?loyw3v28"></script>
```

## Babel

AstroHP recursively compiles every `.ts` and `.tsx` file in the webroot,
excluding `.d.ts` files and private directories, hardcoded to use
Showdown's Babel configuration.

```text
example/
  script.tsx
caches/example/build/
  script.js
  script.js.map
```

This Babel configuration is designed to target ancient browsers while
still letting you write code that looks modern. If you don't care about
targeting ancient browsers, you're probably better off using Astro's
built-in TypeScript support instead.

If you do care about targeting ancient browsers, keep in mind:

- We use Babel in loose mode, so make sure your code follows best practices
- We assume that all `for...of` is on arrays
- We assume that you only ever use `for...in` on bare objects, not arrays
  or primitives
- You can't use anything that doesn't compile down to ES3, such as
  async/await
- We don't polyfill Map/Set because we have no use for them, either

`astrohp build` compiles all directory targets after Astro renders the pages.
`astrohp dev` performs an initial compilation, watches source files through
Vite, recompiles the changed file, and reloads the page. Raw `.ts` and `.tsx`
files are never served.

## Cache directories

AstroHP searches upward from the web root for the nearest `package.json`.
Development caches are grouped by the webroot's package-relative path:

```text
caches/[webroot]/
  .astro/
    vite/
  build/
```

When the package directory is itself the webroot, or when no `package.json`
can be found, AstroHP uses `caches/_root/`.

AstroHP never serves a URL containing `caches` or `node_modules`. Astro's
development toolbar isn't supported.
