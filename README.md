# NodeConnector

A zero-dependency TypeScript class that renders routed SVG connections between nodes. Paths automatically navigate around node rectangles, separate overlapping segments, and draw bridge gaps at crossings.

## Installation

```bash
npm install @pictogrammers/node-connector
```

## Quick start

```html
<svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>

<script type="module">
import { NodeConnector } from '@pictogrammers/node-connector';

const svg = document.getElementById('canvas');
const connector = new NodeConnector(svg);

// Register node bounding boxes
connector.setNode('a', 60,  100, 152, 80);
connector.setNode('b', 320, 100, 152, 80);

// Declare pins by key and relative Y offset
connector.setOutputPin('a', 'out', 40);
connector.setInputPin('b',  'in',  40);

// Connect output pin 'out' of 'a' to input pin 'in' of 'b'
connector.connect('a', 'out', 'b', 'in');
</script>
```

## API

### `new NodeConnector(svg: SVGSVGElement)`

Attaches to an existing `<svg>` element. Appends two `<g>` groups — one for connection paths, one for pin circles — as the last children of the SVG. Place your node markup **before** constructing `NodeConnector` (or insert nodes as `svg.insertBefore(nodeEl, svg.firstChild)`) so the connector's groups render on top.

### Appearance properties

| Property | Default | Description |
|---|---|---|
| `bridgeColor` | `'white'` | Background color painted over the under-path at each crossing to create a bridge gap. Set to match your canvas background. |
| `pathColor` | `'#666'` | Stroke color of connection paths. |
| `pathColorHover` | `'#bbb'` | Stroke color when hovering a connection path. |
| `pathInvalidColor` | `'#F00'` | Stroke color of invalid (backward) connection paths. |
| `pinColor` | `'#999'` | Fill color of pin circles. |
| `pinColorHover` | `'#444'` | Fill color of pin circles on hover. |
| `pinBorder` | `'#333'` | Stroke color of pin circles. |
| `pinBorderHover` | `'#333'` | Stroke color of pin circles on hover. |

Set any of these before calling `connect()` — they are applied at element-creation time (path and pin colors) or read from `this` at event time (hover colors, so they can be changed after the fact).

```ts
connector.bridgeColor      = '#0d1117';
connector.pathColor        = '#4a9eff';
connector.pathColorHover   = '#80bfff';
connector.pathInvalidColor = '#ff4444';
connector.pinColor         = '#4a9eff';
connector.pinColorHover    = '#80bfff';
connector.pinBorder        = '#1a5fa8';
connector.pinBorderHover   = '#4a9eff';
```

### `setNode(nodeId, x, y, width, height)`

Registers or updates a node's bounding box. Call this whenever a node is created or moved. All connected paths are immediately re-routed.

| Param | Type | Description |
|---|---|---|
| `nodeId` | `string` | Unique identifier for the node |
| `x`, `y` | `number` | Top-left corner in SVG coordinates |
| `width`, `height` | `number` | Size of the node rectangle |

```ts
connector.setNode('uuid1', 32, 32, 128, 64);
```

Moving a node:

```ts
node.x += dx;
node.y += dy;
nodeEl.style.left = `${node.x}px`;
nodeEl.style.top  = `${node.y}px`;
connector.setNode(node.id, node.x, node.y, node.w, node.h);
```

### `removeNode(nodeId)`

Removes the node, all its pins, and all connections that reference it.

```ts
connector.removeNode('uuid1');
```

### `setInputPin(nodeId, key, relY)`

Declares (or updates) an input pin on the left edge of a node. `relY` is the vertical offset from the node's top-left corner. If the same `nodeId` + `key` pair already exists the position is updated and all connected paths are re-routed.

```ts
connector.setInputPin('uuid1', 'in',  42);
```

### `setOutputPin(nodeId, key, relY)`

Declares (or updates) an output pin on the right edge of a node.

```ts
connector.setOutputPin('uuid2', 'out', 42);
```

### `removeInputPin(nodeId, key)`

Removes the input pin and any connections that use it.

```ts
connector.removeInputPin('uuid1', 'in');
```

### `removeOutputPin(nodeId, key)`

Removes the output pin and any connections that use it.

```ts
connector.removeOutputPin('uuid2', 'out');
```

### `connect(sourceNodeId, sourceKey, targetNodeId, targetKey)`

Draws a routed path from the output pin `sourceKey` of `sourceNodeId` to the input pin `targetKey` of `targetNodeId`. Both nodes and their respective pins must have been registered first.

```ts
connector.connect('uuid2', 'out', 'uuid1', 'in');
connector.connect('uuid1', 'out', 'uuid3', 'in');
```

The output pin circle is placed on the right edge of the source node; the input pin circle on the left edge of the target node. Pin circles respond to hover, click, and drag.

### `disconnect(sourceNodeId, sourceKey, targetNodeId, targetKey)`

Removes a specific connection path. Pin circles remain until `removeInputPin`, `removeOutputPin`, or `removeNode` is called.

```ts
connector.disconnect('uuid2', 'out', 'uuid1', 'in');
```

### `on('click', callback)`

Fired when a pin circle is clicked or when an output pin is dragged more than 5 px.

```ts
connector.on('click', (pin) => {
    // pin.nodeId  — which node owns the pin
    // pin.key     — the pin's key
    // pin.type    — 'input' | 'output'
});
```

Typical pattern — track the active output pin, then connect on the next input click:

```ts
let active = null;

connector.on('click', (pin) => {
    if (active) {
        if (pin.type === 'input') {
            connector.connect(active.nodeId, active.key, pin.nodeId, pin.key);
            active = null;
        } else {
            active = pin;
            connector.setPreviewPin(pin.nodeId, pin.key);
        }
    } else if (pin.type === 'output') {
        active = pin;
        connector.setPreviewPin(pin.nodeId, pin.key);
    }
});
```

### `on('connection-click', callback)`

Fired when the user clicks anywhere along a connection path (via an invisible 12 px wide hit zone).

```ts
connector.on('connection-click', (sourceNodeId, sourceKey, targetNodeId, targetKey) => {
    connector.disconnect(sourceNodeId, sourceKey, targetNodeId, targetKey);
});
```

### `setPreviewPin(nodeId, key)`

Shows a dashed preview line that follows the cursor from the output pin `key` of `nodeId`. Cleared automatically on any SVG click or `Escape`. Call again with a different node/key to switch the active pin mid-drag.

```ts
connector.setPreviewPin('uuid2', 'out');
```

## Path routing

Paths are cubic bezier curves routed around node rectangles:

- **Forward connections** (target to the right of source) use an iterative waypoint algorithm that detects collisions with intermediate node rectangles and inserts routing waypoints above or below the blocker. The side is chosen based on the source pin's Y position relative to the obstacle's vertical centre — pins higher than the obstacle's midpoint route above it, pins lower route below.
- **Backward connections** (target to the left of source) are drawn as a straight line and styled with `pathInvalidColor` to indicate an invalid connection.
- **Overlapping horizontal segments** across multiple paths at the same Y are spread into parallel lanes (±4 px, ±8 px) so they remain visually distinct. Lane assignment is sorted primarily by source pin Y — for above-routing, higher pins take the outer lane; for below-routing, lower pins take the outer lane — so entry-segment curves maintain their ordering and avoid crossing. Path length is the tiebreaker when two paths share the same source pin Y, with longer paths placed further out.
- **Crossings** between paths get a bridge gap: a short perpendicular segment in `bridgeColor` painted over the under-path so it appears to pass beneath the over-path.

## Development

```bash
npm install
npm run start
# npm run build
```
