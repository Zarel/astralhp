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
