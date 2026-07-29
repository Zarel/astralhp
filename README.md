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

AstroHP supports the usual ways to include CSS and JS, but if you would
prefer a more PHP-style approach, we offer a `<CSS>` component that
cachebusts a stylesheet while leaving it unmodified and in the same
location.

```astro
---
import { CSS } from "astrohp/components";
---
<CSS src="/style.css" />
```

`<CSS>` renders a `<link rel="stylesheet">`, forwards additional link
attributes, and appends the local file's modification time encoded in base 36:

```html
<link rel="stylesheet" href="/style.css?loyw3v28">
```

The source can be root-relative or relative to the rendered page:

```astro
<CSS src="/style/global.css" />
<CSS src="style.css" />
<CSS src="../shared.css" />
```

The resolved file must be inside the webroot. Missing files, existing queries,
fragments, and external URLs are errors.

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
