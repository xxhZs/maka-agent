# Authoring an Extension Client

Declare a Client alongside any Runtime contributions in `maka.extension.json`:

```json
{
  "schemaVersion": 1,
  "id": "dev.maka.weather",
  "ui": {
    "client": {
      "entry": "client/index.js",
      "inject": [],
      "external": [],
      "tools": ["weather.refresh"]
    }
  }
}
```

The entry is a prebuilt classic script. Its only top-level action registers a
factory; the factory exports the lifecycle apply function:

```js
window.__MakaModuleLoader__.load({
  id: 'dev.maka.weather',
  factory(require) {
    const React = require('react');
    return {
      default(ctx) {
        ctx.style('.weather-card { padding: 8px; }');
        return ctx.slots.register(
          { name: 'tool.call.toolview', key: 'weather', priority: 10 },
          ({ toolName }) => React.createElement(
            'section',
            { className: 'weather-card' },
            `Weather result from ${toolName}`,
          ),
        );
      },
    };
  },
});
```

Use `ctx.slots.register()` for inline React contributions. A larger interactive
surface belongs in Maka's existing resizable Workbar:

```js
ctx.workbar.register(
  { id: 'weather', title: 'Weather', description: 'Inspect and edit the forecast' },
  ({ sessionId, active, placement }) => React.createElement(WeatherEditor, {
    sessionId,
    active,
    placement,
    refresh: () => ctx.tools.invoke(sessionId, 'weather.refresh', {}),
  }),
);

ctx.workbar.open('weather', sessionId); // optional, for example from a Tool card
```

The Workbar keeps the conversation, sidebar, and Composer mounted. Views can be
opened on the right or bottom and are removed automatically when their Client is
stopped or reloaded.

`ctx.tools.invoke(sessionId, name, args)` is a narrow Client-to-Runtime bridge.
The Tool must be listed in that Client's `ui.client.tools`, belong to the same
Extension, and be active in the requested session. The Host validates the Tool's
input schema before execution. A Client cannot invoke another Extension's Tools
or arbitrary Host operations.

Use `ctx.style()` for lifecycle-owned CSS and `ctx.effect()` for other disposable
effects. Import React, `react/jsx-runtime`, or `@maka/ui` through `require`; do not
bundle a second React copy. Dependencies must be declared in `inject` or
`external` and are activated before their consumers.

`define_package` accepts the same bundle text as `ui.source`; `manage_package`
activates, reloads, stops, or deletes the whole Extension rather than a separate
UI object.
