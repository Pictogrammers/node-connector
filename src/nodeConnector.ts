const SVG_NS = 'http://www.w3.org/2000/svg';
const PIN_RADIUS = 5;
const ROUTE_PAD = 5; // minimum clearance around node rectangles when routing

export interface Pin {
    nodeId: string;
    key: string;
    type: 'input' | 'output' | 'preview';
}

interface NodeData {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ConnectionData {
    sourceNodeId: string;
    sourceKey: string;
    targetNodeId: string;
    targetKey: string;
    path: SVGPathElement;
    hitZone: SVGPathElement;
    isInvalid: boolean;
    cleanupHover: () => void;
}

interface PinElement {
    nodeId: string;
    key: string;
    relY: number;
    type: 'input' | 'output';
    circle: SVGCircleElement;
}

export class NodeConnector {
    /** Set to your background colour so bridge gaps match the canvas. */
    public bridgeColor      = 'white';
    public pathColor        = '#666';
    public pathColorHover   = '#bbb';
    public pathInvalidColor = '#F00';
    public pinColor         = '#999';
    public pinColorHover    = '#444';
    public pinBorder        = '#333';
    public pinBorderHover   = '#333';
    private _debug = false;
    get debug(): boolean { return this._debug; }
    set debug(value: boolean) {
        this._debug = value;
        if (value) {
            this.svg.appendChild(this.debugGroup);
        } else {
            this.debugGroup.replaceChildren();
            this.debugGroup.remove();
        }
    }

    private nodes = new Map<string, NodeData>();
    private connections: ConnectionData[] = [];
    private pins: PinElement[] = [];
    private bridges: SVGLineElement[] = [];
    private connGroup: SVGGElement;
    private pathGroup: SVGGElement;
    private hitGroup: SVGGElement;
    private pinGroup: SVGGElement;
    private debugGroup: SVGGElement;
    private previewPath: SVGPathElement | null = null;
    private previewPin: Pin | null = null;
    private previewCircle: SVGCircleElement | null = null;
    private listeners = new Map<string, ((...args: any[]) => void)[]>();
    private onSvgMove: ((e: MouseEvent) => void) | null = null;
    private onDocKey: ((e: KeyboardEvent) => void) | null = null;
    private onSvgClick: ((e: MouseEvent) => void) | null = null;

    constructor(private svg: SVGSVGElement) {
        this.connGroup  = document.createElementNS(SVG_NS, 'g');
        this.pathGroup  = document.createElementNS(SVG_NS, 'g');
        this.hitGroup   = document.createElementNS(SVG_NS, 'g');
        this.pinGroup   = document.createElementNS(SVG_NS, 'g');
        this.debugGroup = document.createElementNS(SVG_NS, 'g');
        this.connGroup.appendChild(this.pathGroup);
        this.connGroup.appendChild(this.hitGroup);
        svg.appendChild(this.connGroup);
        svg.appendChild(this.pinGroup);
    }

    setNode(nodeId: string, x: number, y: number, width: number, height: number): void {
        this.nodes.set(nodeId, { x, y, width, height });
        this.redraw();
    }

    removeNode(nodeId: string): void {
        this.nodes.delete(nodeId);
        const toRemove = this.connections.filter(c =>
            c.sourceNodeId === nodeId || c.targetNodeId === nodeId
        );
        for (const conn of toRemove) {
            conn.cleanupHover();
            conn.path.remove();
            conn.hitZone.remove();
        }
        this.connections = this.connections.filter(c =>
            c.sourceNodeId !== nodeId && c.targetNodeId !== nodeId
        );
        const nodePins = this.pins.filter(p => p.nodeId === nodeId);
        for (const pin of nodePins) pin.circle.remove();
        this.pins = this.pins.filter(p => p.nodeId !== nodeId);
        this.redrawPaths();
    }

    setInputPin(nodeId: string, key: string, relY: number): void {
        this.upsertPin(nodeId, key, relY, 'input');
    }

    setOutputPin(nodeId: string, key: string, relY: number): void {
        this.upsertPin(nodeId, key, relY, 'output');
    }

    removeInputPin(nodeId: string, key: string): void {
        this.removePinAndConnections(nodeId, key, 'input');
    }

    removeOutputPin(nodeId: string, key: string): void {
        this.removePinAndConnections(nodeId, key, 'output');
    }

    connect(sourceNodeId: string, sourceKey: string, targetNodeId: string, targetKey: string): void {
        if (!this.nodes.has(sourceNodeId) || !this.nodes.has(targetNodeId)) return;
        if (!this.pins.some(p => p.nodeId === sourceNodeId && p.key === sourceKey && p.type === 'output')) return;
        if (!this.pins.some(p => p.nodeId === targetNodeId && p.key === targetKey && p.type === 'input')) return;

        const path = this.newPath(false);
        const hitZone = this.newHitZone();
        let hoverMarker: SVGGElement | null = null;
        hitZone.addEventListener('mouseenter', () => {
            path.setAttribute('stroke', this.pathColorHover);
            path.setAttribute('stroke-width', '3');
            hoverMarker = document.createElementNS(SVG_NS, 'g');
            this.pathGroup.insertBefore(hoverMarker, path);
            this.pathGroup.appendChild(path);
        });
        const connData: ConnectionData = {
            sourceNodeId, sourceKey, targetNodeId, targetKey, path, hitZone, isInvalid: false,
            cleanupHover: () => { hoverMarker?.remove(); hoverMarker = null; },
        };
        hitZone.addEventListener('mouseleave', () => {
            path.setAttribute('stroke', connData.isInvalid ? this.pathInvalidColor : this.pathColor);
            path.setAttribute('stroke-width', '2');
            if (hoverMarker) {
                this.pathGroup.insertBefore(path, hoverMarker);
                hoverMarker.remove();
                hoverMarker = null;
            }
        });
        hitZone.addEventListener('click', () => {
            this.emit('connection-click', sourceNodeId, sourceKey, targetNodeId, targetKey);
        });
        this.pathGroup.appendChild(path);
        this.hitGroup.appendChild(hitZone);
        this.connections.push(connData);
        this.redrawPaths();
    }

    disconnect(sourceNodeId: string, sourceKey: string, targetNodeId: string, targetKey: string): void {
        const idx = this.connections.findIndex(c =>
            c.sourceNodeId === sourceNodeId && c.sourceKey === sourceKey &&
            c.targetNodeId === targetNodeId && c.targetKey === targetKey
        );
        if (idx === -1) return;
        const [conn] = this.connections.splice(idx, 1);
        conn.cleanupHover();
        conn.path.remove();
        conn.hitZone.remove();
        this.redrawPaths();
    }

    on(event: 'click', callback: (pin: Pin) => void): void;
    on(event: 'connection-click', callback: (sourceNodeId: string, sourceKey: string, targetNodeId: string, targetKey: string) => void): void;
    on(event: string, callback: (...args: any[]) => void): void {
        const list = this.listeners.get(event) ?? [];
        list.push(callback);
        this.listeners.set(event, list);
    }

    // Creates a dashed preview line from nodeId's output pin that tracks the cursor.
    // Removed on any SVG click or Escape.
    setPreviewPin(nodeId: string, key: string): void {
        this.clearPreview();
        const node = this.nodes.get(nodeId);
        if (!node) return;
        const srcPin = this.pins.find(p => p.nodeId === nodeId && p.key === key && p.type === 'output');
        if (!srcPin) return;

        this.previewPin = { nodeId, key, type: 'preview' };
        this.previewPath = this.newPath(true);
        this.connGroup.appendChild(this.previewPath);

        this.previewCircle = this.newCircle(node.x + node.width, node.y + srcPin.relY);
        this.pinGroup.appendChild(this.previewCircle);

        this.onSvgMove = (e: MouseEvent) => {
            if (!this.previewPath || !this.previewPin) return;
            const n = this.nodes.get(this.previewPin.nodeId);
            const pin = this.pins.find(p => p.nodeId === this.previewPin!.nodeId && p.key === this.previewPin!.key && p.type === 'output');
            if (!n || !pin) return;
            const pt = this.toSvgCoords(e.clientX, e.clientY);
            this.setD(this.previewPath, n.x + n.width, n.y + pin.relY, pt.x, pt.y);
        };

        this.onDocKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') this.clearPreview();
        };

        this.onSvgClick = () => this.clearPreview();

        document.addEventListener('mousemove', this.onSvgMove);
        document.addEventListener('keydown', this.onDocKey);
        // Defer so the click that triggered this call doesn't bubble to SVG and immediately clear preview
        setTimeout(() => { if (this.onSvgClick) this.svg.addEventListener('click', this.onSvgClick); }, 0);
    }

    private clearPreview(): void {
        this.previewPath?.remove();
        this.previewPath = null;
        this.previewCircle?.remove();
        this.previewCircle = null;
        this.previewPin = null;
        if (this.onSvgMove) { document.removeEventListener('mousemove', this.onSvgMove); this.onSvgMove = null; }
        if (this.onDocKey) { document.removeEventListener('keydown', this.onDocKey); this.onDocKey = null; }
        if (this.onSvgClick) { this.svg.removeEventListener('click', this.onSvgClick); this.onSvgClick = null; }
    }

    private upsertPin(nodeId: string, key: string, relY: number, type: 'input' | 'output'): void {
        const existing = this.pins.find(p => p.nodeId === nodeId && p.key === key && p.type === type);
        if (existing) {
            existing.relY = relY;
            this.redraw();
            return;
        }
        const node = this.nodes.get(nodeId);
        const cx = node ? (type === 'output' ? node.x + node.width : node.x) : 0;
        const cy = node ? node.y + relY : 0;
        const circle = this.newCircle(cx, cy);
        circle.style.cursor = 'pointer';
        circle.addEventListener('click', () => {
            this.emit('click', { nodeId, key, type } as Pin);
        });
        circle.addEventListener('mouseenter', () => {
            circle.setAttribute('fill', this.pinColorHover);
            circle.setAttribute('stroke', this.pinBorderHover);
        });
        circle.addEventListener('mouseleave', () => {
            circle.setAttribute('fill', this.pinColor);
            circle.setAttribute('stroke', this.pinBorder);
        });

        if (type === 'output') {
            let dragging = false;
            let startX = 0, startY = 0;

            const onDragMove = (e: MouseEvent) => {
                if (dragging) return;
                if (Math.hypot(e.clientX - startX, e.clientY - startY) > 5) {
                    dragging = true;
                    this.emit('click', { nodeId, key, type } as Pin);
                }
            };

            const onDragUp = (e: MouseEvent) => {
                document.removeEventListener('mousemove', onDragMove);
                document.removeEventListener('mouseup', onDragUp);
                if (!dragging) return;
                dragging = false;
                const el = document.elementFromPoint(e.clientX, e.clientY);
                const target = this.pins.find(p => p.circle === el && p.type === 'input');
                if (target) {
                    this.emit('click', { nodeId: target.nodeId, key: target.key, type: target.type } as Pin);
                }
                this.clearPreview();
            };

            circle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                dragging = false;
                startX = e.clientX;
                startY = e.clientY;
                document.addEventListener('mousemove', onDragMove);
                document.addEventListener('mouseup', onDragUp);
            });
        }

        this.pinGroup.appendChild(circle);
        this.pins.push({ nodeId, key, relY, type, circle });
    }

    private removePinAndConnections(nodeId: string, key: string, type: 'input' | 'output'): void {
        const toRemove = this.connections.filter(c =>
            type === 'output'
                ? c.sourceNodeId === nodeId && c.sourceKey === key
                : c.targetNodeId === nodeId && c.targetKey === key
        );
        for (const conn of toRemove) {
            conn.cleanupHover();
            conn.path.remove();
            conn.hitZone.remove();
        }
        this.connections = this.connections.filter(c => !toRemove.includes(c));
        const idx = this.pins.findIndex(p => p.nodeId === nodeId && p.key === key && p.type === type);
        if (idx !== -1) {
            this.pins[idx].circle.remove();
            this.pins.splice(idx, 1);
        }
        this.redrawPaths();
    }

    private redraw(): void {
        this.redrawPaths();
        for (const pin of this.pins) {
            const node = this.nodes.get(pin.nodeId);
            if (!node) continue;
            pin.circle.setAttribute('cx', String(pin.type === 'output' ? node.x + node.width : node.x));
            pin.circle.setAttribute('cy', String(node.y + pin.relY));
        }
    }

    // ── Routing ───────────────────────────────────────────────────────────────

    private redrawPaths(): void {
        const allPts = this.connections.map(conn => this.computeWaypoints(conn));
        this.nudgeHorizontalSegments(allPts);
        this.nudgeVerticalSegments(allPts);
        this.debugGroup.replaceChildren();
        for (let i = 0; i < this.connections.length; i++) {
            const conn = this.connections[i];
            const src = this.nodes.get(conn.sourceNodeId);
            const tgt = this.nodes.get(conn.targetNodeId);
            conn.isInvalid = !!(src && tgt && tgt.x < src.x + src.width);
            conn.path.setAttribute('stroke', conn.isInvalid ? this.pathInvalidColor : this.pathColor);
            this.applyPathPoints(conn, allPts[i]);
        }
        this.drawBridges(allPts);
    }

    private computeWaypoints(conn: ConnectionData): number[][] {
        const src = this.nodes.get(conn.sourceNodeId);
        const tgt = this.nodes.get(conn.targetNodeId);
        if (!src || !tgt) return [];
        const srcPin = this.pins.find(p => p.nodeId === conn.sourceNodeId && p.key === conn.sourceKey && p.type === 'output');
        const tgtPin = this.pins.find(p => p.nodeId === conn.targetNodeId && p.key === conn.targetKey && p.type === 'input');
        if (!srcPin || !tgtPin) return [];
        const sx = src.x + src.width, sy = src.y + srcPin.relY;
        const ex = tgt.x,             ey = tgt.y + tgtPin.relY;
        const avoid = [...this.nodes.entries()]
            .filter(([id]) => id !== conn.sourceNodeId && id !== conn.targetNodeId)
            .map(([, n]) => n);
        if (ex >= sx) {
            const STUB = 8;
            const routed = this.buildWaypoints(sx, sy, ex, ey, avoid);
            // Always insert an end stub so the path arrives at the input pin from the left.
            // When routing goes via an obstacle's right edge (prevX > ex), the path would
            // otherwise approach right-to-left and overlap the target node body.
            // Fix: if the last waypoint is right of the stub zone, first descend to pin Y,
            // then the stub provides a clean left-to-right final approach.
            const n = routed.length;
            if (n >= 2) {
                const prevX = routed[n - 2][0];
                const prevY = routed[n - 2][1];
                const stubX = ex - STUB;
                if (prevX > stubX) {
                    // Path arrives from the right of the approach zone. A direct descent to
                    // ey at prevX cuts through the target node body. Instead route around
                    // the target node's nearest corner (top-left or bottom-left) so the
                    // approach descends along the outside of the node before the stub.
                    if (prevY <= tgt.y) {
                        routed.splice(n - 1, 0, [stubX, tgt.y - ROUTE_PAD]);
                    } else if (prevY >= tgt.y + tgt.height) {
                        routed.splice(n - 1, 0, [stubX, tgt.y + tgt.height + ROUTE_PAD]);
                    }
                }
                routed.splice(routed.length - 1, 0, [stubX, ey]);
            }
            return routed;
        }
        // Backward connection: straight line, rendered as invalid
        return [[sx, sy], [ex, ey]];
    }

    // Iteratively inserts waypoints at the edges of blocking nodes until no segment intersects one.
    private buildWaypoints(sx: number, sy: number, ex: number, ey: number, avoid: NodeData[]): number[][] {
        const STUB = 8;
        let pts: number[][] = [[sx, sy], [sx + STUB, sy], [ex, ey]];
        for (let iter = 0; iter < 50; iter++) {
            let changed = false;
            const next: number[][] = [pts[0]];
            for (let i = 0; i < pts.length - 1; i++) {
                const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
                const blockers = avoid
                    .filter(n => this.segHitsNode(ax, ay, bx, by, n))
                    .sort((a, b) => a.x - b.x);
                if (blockers.length > 0) {
                    changed = true;
                    // Merge blockers whose x exclusion zones overlap. Vertically stacked
                    // nodes share the same x range, and processing them independently
                    // produces backward (right-to-left) waypoint segments that cut through
                    // the nodes above/below. Merging treats the stack as one obstacle.
                    type Group = { blRx: number; blRr: number; minRy: number; maxRb: number };
                    const merged: Group[] = [];
                    for (const bl of blockers) {
                        const blRy = bl.y - ROUTE_PAD, blRb = bl.y + bl.height + ROUTE_PAD;
                        const blRx = bl.x - ROUTE_PAD, blRr = bl.x + bl.width  + ROUTE_PAD;
                        const last = merged[merged.length - 1];
                        if (last && blRx <= last.blRr) {
                            last.blRr  = Math.max(last.blRr,  blRr);
                            last.minRy = Math.min(last.minRy, blRy);
                            last.maxRb = Math.max(last.maxRb, blRb);
                        } else {
                            merged.push({ blRx, blRr, minRy: blRy, maxRb: blRb });
                        }
                    }
                    for (const g of merged) {
                        let routeY = ay <= (g.minRy + g.maxRb) / 2 ? g.minRy : g.maxRb;
                        const exitX = Math.min(g.blRr, bx);
                        if (exitX === bx) {
                            const entryX = Math.max(g.blRx, ax);
                            if (ax > g.blRx) {
                                // Both source and target X are inside the obstacle's X range.
                                // The single-entry-waypoint approach stalls on vertical segments
                                // because the entry→target segment still cuts through the obstacle.
                                // Instead route via the obstacle's right edge:
                                //   descend/ascend to the near Y boundary → travel right to blRr
                                //   → clear the far Y boundary, then head to target.
                                if (ay <= g.minRy) {
                                    next.push([entryX, g.minRy]);
                                    next.push([g.blRr, g.minRy]);
                                    next.push([g.blRr, g.maxRb]);
                                } else if (ay >= g.maxRb) {
                                    next.push([entryX, g.maxRb]);
                                    next.push([g.blRr, g.maxRb]);
                                } else {
                                    next.push([g.blRr, ay]);
                                }
                            } else {
                                // Source is left of obstacle; target is inside its X range.
                                // Flip routeY so a vertical drop to by doesn't re-enter the blocker.
                                if (routeY === g.minRy && by > g.maxRb) routeY = g.maxRb;
                                else if (routeY === g.maxRb && by < g.minRy) routeY = g.minRy;
                                next.push([ax, routeY]);
                            }
                        } else {
                            next.push([Math.max(g.blRx, ax), routeY]);
                            next.push([exitX, routeY]);
                        }
                    }
                }
                next.push(pts[i + 1]);
            }
            pts = next;
            if (!changed) break;
        }
        return pts;
    }

    // Samples the cubic bezier implied between two waypoints to check clearance.
    private segHitsNode(ax: number, ay: number, bx: number, by: number, n: NodeData): boolean {
        const rx = n.x - ROUTE_PAD, ry = n.y - ROUTE_PAD;
        const rr = n.x + n.width + ROUTE_PAD, rb = n.y + n.height + ROUTE_PAD;
        if (bx <= rx || ax >= rr) return false;
        if (Math.max(ay, by) <= ry || Math.min(ay, by) >= rb) return false;
        const midX = (ax + bx) / 2;
        const p0 = [ax, ay], p1 = [midX, ay], p2 = [midX, by], p3 = [bx, by];
        const steps = Math.max(50, Math.ceil((bx - ax) / 4));
        for (let i = 0; i <= steps; i++) {
            const [px, py] = this.cubicPt(p0, p1, p2, p3, i / steps);
            if (px > rx && px < rr && py > ry && py < rb) return true;
        }
        return false;
    }

    private cubicPt(p0: number[], p1: number[], p2: number[], p3: number[], t: number): number[] {
        const m = 1 - t;
        return [
            m*m*m*p0[0] + 3*m*m*t*p1[0] + 3*m*t*t*p2[0] + t*t*t*p3[0],
            m*m*m*p0[1] + 3*m*m*t*p1[1] + 3*m*t*t*p2[1] + t*t*t*p3[1],
        ];
    }

    // Offsets overlapping co-linear horizontal segments so they don't draw on top of each other.
    private nudgeHorizontalSegments(allPts: number[][][]): void {
        const nudgeStep = 4;

        for (const node of this.nodes.values()) {
            for (const isAbove of [true, false]) {
                const segY = isAbove
                    ? node.y - ROUTE_PAD
                    : node.y + node.height + ROUTE_PAD;

                // Collect the full contiguous horizontal run at segY for each connection.
                // A single path routing above multiple adjacent nodes produces several
                // consecutive waypoints at the same Y; treating only the first pair leaves
                // the tail segments at the original Y where they overlap with other paths.
                type ConnSeg = { c: number; runLeft: number; runRight: number; x1: number; x2: number };
                const connSegs: ConnSeg[] = [];
                for (let c = 0; c < allPts.length; c++) {
                    if (this.connections[c].isInvalid) continue;
                    const pts = allPts[c];
                    for (let i = 0; i + 1 < pts.length; i++) {
                        if (pts[i][1] === segY && pts[i + 1][1] === segY) {
                            // Extend to the full contiguous run at segY.
                            let runLeft = i;
                            while (runLeft > 0 && pts[runLeft - 1][1] === segY) runLeft--;
                            let runRight = i + 1;
                            while (runRight < pts.length - 1 && pts[runRight + 1][1] === segY) runRight++;
                            let x1 = pts[runLeft][0], x2 = x1;
                            for (let j = runLeft + 1; j <= runRight; j++) {
                                if (pts[j][0] < x1) x1 = pts[j][0];
                                if (pts[j][0] > x2) x2 = pts[j][0];
                            }
                            connSegs.push({ c, runLeft, runRight, x1, x2 });
                            break;
                        }
                    }
                }
                if (connSegs.length < 2) continue;

                // Only process connections whose x-ranges overlap.
                const overlapping = connSegs.filter((cs, k) =>
                    connSegs.some((other, j) => j !== k && cs.x1 < other.x2 && other.x1 < cs.x2)
                );
                if (overlapping.length < 2) continue;

                // Sort so index 0 is the innermost lane (closest to the node edge).
                // Above: larger source Y → inner (path approaches from further below → gentler arc → inner).
                // Below: smaller source Y → inner (path approaches from further above → gentler arc → inner).
                // Tiebreaker: shorter path → inner.
                const pathLen = (c: number) => {
                    const p = allPts[c];
                    let d = 0;
                    for (let i = 1; i < p.length; i++) {
                        const dx = p[i][0] - p[i-1][0], dy = p[i][1] - p[i-1][1];
                        d += Math.sqrt(dx*dx + dy*dy);
                    }
                    return d;
                };
                const lengths = new Map(overlapping.map(cs => [cs.c, pathLen(cs.c)]));
                overlapping.sort((a, b) => {
                    const aY = allPts[a.c][0][1], bY = allPts[b.c][0][1];
                    const yDiff = isAbove ? bY - aY : aY - bY;
                    if (yDiff !== 0) return yDiff;
                    return lengths.get(a.c)! - lengths.get(b.c)!;
                });

                // Apply per-lane offsets: index 0 stays at segY, outer lanes spread away.
                for (let k = 0; k < overlapping.length; k++) {
                    const delta = isAbove ? -k * nudgeStep : k * nudgeStep;
                    if (!delta) continue;
                    const { c, runLeft, runRight } = overlapping[k];
                    const pts = allPts[c];
                    for (let j = runLeft; j <= runRight; j++) pts[j][1] += delta;
                    // Spread outermost X so approach and descent curves also separate,
                    // but clamp so neither end backtracks past its neighbour.
                    pts[runLeft][0]  -= Math.abs(delta);
                    pts[runRight][0] += Math.abs(delta);
                    if (runLeft > 0)              pts[runLeft][0]  = Math.max(pts[runLeft][0],  pts[runLeft  - 1][0]);
                    if (runRight < pts.length - 1) pts[runRight][0] = Math.min(pts[runRight][0], pts[runRight + 1][0]);
                }
            }
        }
    }

    // Offsets overlapping co-linear vertical segments so they don't draw on top of each other.
    private nudgeVerticalSegments(allPts: number[][][]): void {
        const nudgeStep = 4;

        for (const node of this.nodes.values()) {
            for (const isLeft of [true, false]) {
                const segX = isLeft
                    ? node.x - ROUTE_PAD
                    : node.x + node.width + ROUTE_PAD;

                type ConnSeg = { c: number; runStart: number; runEnd: number; y1: number; y2: number };
                const connSegs: ConnSeg[] = [];
                for (let c = 0; c < allPts.length; c++) {
                    if (this.connections[c].isInvalid) continue;
                    const pts = allPts[c];
                    for (let i = 0; i + 1 < pts.length; i++) {
                        if (pts[i][0] === segX && pts[i + 1][0] === segX) {
                            let runStart = i;
                            while (runStart > 0 && pts[runStart - 1][0] === segX) runStart--;
                            let runEnd = i + 1;
                            while (runEnd < pts.length - 1 && pts[runEnd + 1][0] === segX) runEnd++;
                            let y1 = pts[runStart][1], y2 = y1;
                            for (let j = runStart + 1; j <= runEnd; j++) {
                                if (pts[j][1] < y1) y1 = pts[j][1];
                                if (pts[j][1] > y2) y2 = pts[j][1];
                            }
                            connSegs.push({ c, runStart, runEnd, y1, y2 });
                            break;
                        }
                    }
                }
                if (connSegs.length < 2) continue;

                const overlapping = connSegs.filter((cs, k) =>
                    connSegs.some((other, j) => j !== k && cs.y1 < other.y2 && other.y1 < cs.y2)
                );
                if (overlapping.length < 2) continue;

                const pathLen = (c: number) => {
                    const p = allPts[c];
                    let d = 0;
                    for (let i = 1; i < p.length; i++) {
                        const dx = p[i][0] - p[i-1][0], dy = p[i][1] - p[i-1][1];
                        d += Math.sqrt(dx*dx + dy*dy);
                    }
                    return d;
                };
                overlapping.sort((a, b) => pathLen(a.c) - pathLen(b.c));

                for (let k = 0; k < overlapping.length; k++) {
                    const delta = isLeft ? -k * nudgeStep : k * nudgeStep;
                    if (!delta) continue;
                    const { c, runStart, runEnd } = overlapping[k];
                    const pts = allPts[c];
                    for (let j = runStart; j <= runEnd; j++) pts[j][0] += delta;
                    // Spread outermost Y so approach and descent curves also separate,
                    // but clamp so neither end overshoots its neighbour.
                    const goingDown = pts[runStart][1] <= pts[runEnd][1];
                    if (goingDown) {
                        pts[runStart][1] -= Math.abs(delta);
                        pts[runEnd][1]   += Math.abs(delta);
                        if (runStart > 0)              pts[runStart][1] = Math.max(pts[runStart][1], pts[runStart - 1][1]);
                        if (runEnd < pts.length - 1)   pts[runEnd][1]   = Math.min(pts[runEnd][1],   pts[runEnd   + 1][1]);
                    } else {
                        pts[runStart][1] += Math.abs(delta);
                        pts[runEnd][1]   -= Math.abs(delta);
                        if (runStart > 0)              pts[runStart][1] = Math.min(pts[runStart][1], pts[runStart - 1][1]);
                        if (runEnd < pts.length - 1)   pts[runEnd][1]   = Math.max(pts[runEnd][1],   pts[runEnd   + 1][1]);
                    }
                }
            }
        }
    }

    private applyPathPoints(conn: ConnectionData, pts: number[][]): void {
        if (!pts.length) return;
        let d: string;
        if (conn.isInvalid) {
            d = `M ${pts[0][0]} ${pts[0][1]} L ${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
        } else {
            const R = 8;
            d = `M ${pts[0][0]} ${pts[0][1]}`;
            let px = pts[0][0], py = pts[0][1];
            let prevWasCorner = false;
            for (let i = 1; i < pts.length; i++) {
                const [bx, by] = pts[i];
                let segEndX = bx, segEndY = by;
                let cornerEndX = bx, cornerEndY = by;
                let hasCorner = false;
                if (i < pts.length - 1) {
                    const [ax, ay] = pts[i - 1];
                    const [nx, ny] = pts[i + 1];
                    const inLen = Math.hypot(bx - ax, by - ay);
                    const outLen = Math.hypot(nx - bx, ny - by);
                    if (inLen > 0 && outLen > 0) {
                        const inDx = (bx - ax) / inLen, inDy = (by - ay) / inLen;
                        const outDx = (nx - bx) / outLen, outDy = (ny - by) / outLen;
                        // Only round corners between axis-aligned segments (routing waypoints
                        // are always H/V; diagonal S-curves are already smooth via midX bezier).
                        const inH = Math.abs(inDy) < 0.01, inV = Math.abs(inDx) < 0.01;
                        const outH = Math.abs(outDy) < 0.01, outV = Math.abs(outDx) < 0.01;
                        if ((inH || inV) && (outH || outV) && inDx * outDx + inDy * outDy < 0.99) {
                            const trim = Math.min(R, inLen / 2, outLen / 2);
                            segEndX = bx - inDx * trim;
                            segEndY = by - inDy * trim;
                            cornerEndX = bx + outDx * trim;
                            cornerEndY = by + outDy * trim;
                            hasCorner = true;
                        }
                    }
                }
                const sdx = segEndX - px, sdy = segEndY - py;
                if (Math.abs(sdx) < 15 && Math.abs(sdy) > 15) {
                    // Nearly vertical: straight line with small arcs at each end.
                    // When arriving from a corner (prevWasCorner), the corner Q already
                    // departed vertically — use a line to preserve that tangent instead of
                    // a Q that would introduce a horizontal kink.
                    // When departing into a corner (hasCorner), the corner Q expects a
                    // vertical arrival tangent — again use a line rather than a Q.
                    const vx = (px + segEndX) / 2;
                    const sign = sdy > 0 ? 1 : -1;
                    const r = Math.min(4, Math.abs(sdy) / 4);
                    if (prevWasCorner) {
                        d += ` L ${vx} ${py + sign * r}`;
                    } else {
                        d += ` Q ${vx} ${py} ${vx} ${py + sign * r}`;
                    }
                    if (Math.abs(sdy) > r * 2) d += ` L ${vx} ${segEndY - sign * r}`;
                    if (hasCorner) {
                        d += ` L ${segEndX} ${segEndY}`;
                    } else {
                        d += ` Q ${vx} ${segEndY} ${segEndX} ${segEndY}`;
                    }
                } else {
                    const midX = (px + segEndX) / 2;
                    d += ` C ${midX} ${py} ${midX} ${segEndY} ${segEndX} ${segEndY}`;
                }
                if (hasCorner) {
                    d += ` Q ${bx} ${by} ${cornerEndX} ${cornerEndY}`;
                }
                px = hasCorner ? cornerEndX : bx;
                py = hasCorner ? cornerEndY : by;
                prevWasCorner = hasCorner;
                if (this.debug && i < pts.length - 1) {
                    const dot = document.createElementNS(SVG_NS, 'circle');
                    dot.setAttribute('cx', String(bx));
                    dot.setAttribute('cy', String(by));
                    dot.setAttribute('r', '2');
                    dot.setAttribute('fill', 'red');
                    dot.setAttribute('pointer-events', 'none');
                    this.debugGroup.appendChild(dot);
                }
            }
        }
        conn.path.setAttribute('d', d);
        conn.hitZone.setAttribute('d', d);
    }

    private samplePathPts(pts: number[][], n: number): { x: number; y: number; t: number }[] {
        const segs = pts.length - 1;
        const out: { x: number; y: number; t: number }[] = [];
        for (let i = 0; i <= n; i++) {
            const gT = i / n;
            const sf = Math.min(gT * segs, segs - 1e-9);
            const si = Math.floor(sf);
            const lt = sf - si;
            const [ax, ay] = pts[si], [bx, by] = pts[si + 1];
            const mx = (ax + bx) / 2;
            const [x, y] = this.cubicPt([ax, ay], [mx, ay], [mx, by], [bx, by], lt);
            out.push({ x, y, t: gT });
        }
        return out;
    }

    private polylineIntersect(
        sa: { x: number; y: number; t: number }[],
        sb: { x: number; y: number; t: number }[]
    ): { x: number; y: number; ta: number; tb: number }[] {
        const hits: { x: number; y: number; ta: number; tb: number }[] = [];
        for (let i = 0; i < sa.length - 1; i++) {
            for (let j = 0; j < sb.length - 1; j++) {
                const d1x = sa[i+1].x - sa[i].x, d1y = sa[i+1].y - sa[i].y;
                const d2x = sb[j+1].x - sb[j].x, d2y = sb[j+1].y - sb[j].y;
                const cross = d1x * d2y - d1y * d2x;
                if (Math.abs(cross) < 1e-6) continue;
                const t = ((sb[j].x - sa[i].x) * d2y - (sb[j].y - sa[i].y) * d2x) / cross;
                const u = ((sb[j].x - sa[i].x) * d1y - (sb[j].y - sa[i].y) * d1x) / cross;
                if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
                    const hx = sa[i].x + t * d1x, hy = sa[i].y + t * d1y;
                    if (hits.some(h => Math.abs(h.x - hx) < 3 && Math.abs(h.y - hy) < 3)) continue;
                    hits.push({
                        x: hx, y: hy,
                        ta: sa[i].t + t * (sa[i+1].t - sa[i].t),
                        tb: sb[j].t + u * (sb[j+1].t - sb[j].t)
                    });
                }
            }
        }
        return hits;
    }

    private pathTangentAt(pts: number[][], t: number): [number, number] {
        const segs = pts.length - 1;
        const sf = Math.min(t * segs, segs - 1e-9);
        const si = Math.floor(sf);
        const lt = sf - si;
        const [ax, ay] = pts[si], [bx, by] = pts[si + 1];
        const mx = (ax + bx) / 2;
        const p0 = [ax, ay], p1 = [mx, ay], p2 = [mx, by], p3 = [bx, by];
        const m = 1 - lt;
        const dx = 3 * (m*m*(p1[0]-p0[0]) + 2*m*lt*(p2[0]-p1[0]) + lt*lt*(p3[0]-p2[0]));
        const dy = 3 * (m*m*(p1[1]-p0[1]) + 2*m*lt*(p2[1]-p1[1]) + lt*lt*(p3[1]-p2[1]));
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        return [dx/len, dy/len];
    }

    private drawBridges(allPts: number[][][]): void {
        for (const el of this.bridges) el.remove();
        this.bridges = [];
        if (allPts.length < 2) return;
        const HALF = 6;
        const samples = allPts.map((p, i) => this.connections[i].isInvalid ? [] : this.samplePathPts(p, 150));
        for (let a = 0; a < allPts.length; a++) {
            if (this.connections[a].isInvalid) continue;
            for (let b = a + 1; b < allPts.length; b++) {
                if (this.connections[b].isInvalid) continue;
                const endpts = [
                    allPts[a][0],
                    allPts[a][allPts[a].length - 1],
                    allPts[b][0],
                    allPts[b][allPts[b].length - 1],
                ];
                for (const hit of this.polylineIntersect(samples[a], samples[b])) {
                    if (endpts.some(([ex, ey]) => Math.hypot(hit.x - ex, hit.y - ey) < 8)) continue;
                    // Reject near-tangency false positives: path B's samples immediately
                    // before and after the hit must be on opposite sides of path A's
                    // tangent at the intersection. Same-side means the curves approached
                    // but did not genuinely cross.
                    const sb = samples[b];
                    const k = sb.findIndex(s => s.t >= hit.tb);
                    if (k > 0 && k < sb.length) {
                        const [tax, tay] = this.pathTangentAt(allPts[a], hit.ta);
                        const s0 = tax * (sb[k - 1].y - hit.y) - tay * (sb[k - 1].x - hit.x);
                        const s1 = tax * (sb[k].y     - hit.y) - tay * (sb[k].x     - hit.x);
                        if (s0 * s1 >= 0) continue;
                    }
                    const [otx, oty] = this.pathTangentAt(allPts[b], hit.tb);
                    const el = document.createElementNS(SVG_NS, 'line');
                    el.setAttribute('x1', String(hit.x - otx * HALF));
                    el.setAttribute('y1', String(hit.y - oty * HALF));
                    el.setAttribute('x2', String(hit.x + otx * HALF));
                    el.setAttribute('y2', String(hit.y + oty * HALF));
                    el.setAttribute('stroke', this.bridgeColor);
                    el.setAttribute('stroke-width', '4');
                    el.setAttribute('stroke-opacity', '0.8');
                    el.setAttribute('stroke-linecap', 'round');
                    this.pathGroup.insertBefore(el, this.connections[b].path);
                    this.bridges.push(el);
                }
            }
        }
    }

    // Used only for the live preview line (cursor-following).
    private setD(path: SVGPathElement, x1: number, y1: number, x2: number, y2: number): void {
        const dx = Math.max(Math.abs(x2 - x1) * 0.5, 40);
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`);
    }

    private newHitZone(): SVGPathElement {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'transparent');
        p.setAttribute('stroke-width', '10');
        p.style.cursor = 'pointer';
        return p;
    }

    private newPath(dashed: boolean): SVGPathElement {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', this.pathColor);
        p.setAttribute('stroke-width', '2');
        p.setAttribute('pointer-events', 'none');
        if (dashed) p.setAttribute('stroke-dasharray', '6 3');
        return p;
    }

    private newCircle(cx: number, cy: number): SVGCircleElement {
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', String(cx));
        c.setAttribute('cy', String(cy));
        c.setAttribute('r', String(PIN_RADIUS));
        c.setAttribute('fill', this.pinColor);
        c.setAttribute('stroke', this.pinBorder);
        c.setAttribute('stroke-width', '1');
        return c;
    }

    private toSvgCoords(clientX: number, clientY: number): DOMPoint {
        const pt = this.svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        return pt.matrixTransform(this.svg.getScreenCTM()!.inverse());
    }

    private emit(event: string, ...args: any[]): void {
        for (const cb of this.listeners.get(event) ?? []) cb(...args);
    }
}
