# Extension Client contributions

Extension UI is the Client half of the unified Extension package. A package
declares one prebuilt classic-script factory at `ui.client.entry`; the same
Composition Entry lifecycle that owns its Tool, Hook, Event, Service, and Timer
contributions owns this Client generation.

## Slot contract

Maka implements the DSH `b150a551b` UI boundary: a typed `SlotMap`,
`single/list/keyed/chain` composition, `root/session/session-maybe` scopes,
typed owner and key props, selectors, priority, fallbacks, child Slot ownership,
and recursive disposal. The catalog contains the exact 48 DSH Slot names.

The Renderer has real mount positions for the 45 contracts represented by
Maka's current product UI. `conversation.chat.commandview`,
`conversation.details.tool`, and `tool.view.cordis` remain typed contracts until
Maka has corresponding business surfaces; no placeholder DOM is invented.

## Loading and trust

The Runtime Host projects active Client bytes, digest, and declared
`inject`/`external` dependencies for the `desktop-ui` scope. Electron serves an
exact active bundle through the private `maka-client-plugin:` protocol. The
Renderer loads the factory against host-owned React, JSX Runtime, and
`@maka/ui` singletons and exposes only the plugin lifecycle context.

Client code is trusted and runs in the host Renderer realm. There is no iframe,
opaque origin, postMessage bridge, separate UI state store, or compatibility
path for the retired HTML contribution format.

## Lifecycle

Registrations, CSS, and arbitrary effects are staged before activation. A
successful update swaps them atomically; a failed candidate leaves the current
generation active. Disable, stop, delete, dependency loss, and Renderer teardown
dispose owned effects and restore Slot fallbacks. Restart reconstructs the
Client graph from the same durable Entry Tree as every other contribution.

Tests cover the exact Slot catalog, composition semantics, typed rendering,
dependency ordering, atomic replacement, cleanup, package activation, private
bundle transport, and Electron lifecycle behavior.
