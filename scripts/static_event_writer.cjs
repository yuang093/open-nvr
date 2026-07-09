// scripts/static_event_writer.cjs
/**
 * Write a static airplane event to NVR movement DB.
 * Invoked as: node static_event_writer.cjs --cameraKey <key> --cameraName <name> --event arrived|departed --trackId <id>
 *
 * Why Node.js: avoid Python leveldb library colliding with NVR server's lock.
 * NVR server (Python / TS) already writes movements sublevel. We use the same
 * format so /api/movements picks them up automatically.
 *
 * Note: file is .cjs (not .js) because package.json declares "type":"module",
 * which would otherwise force ESM and break `require()`.
 */

const path = require('path');
const { Level } = require('level');

const DBPATH = process.env.NVR_DBPATH || path.join(__dirname, '..', 'mydb');

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.cameraKey || !args.event || !args.trackId) {
        console.error('Usage: node static_event_writer.cjs --cameraKey <key> --cameraName <name> --event <arrived|departed> --trackId <id>');
        process.exit(2);
    }

    const db = new Level(DBPATH, { valueEncoding: 'json' });
    const movements = db.sublevel('movements', { valueEncoding: 'json' });

    const movementKey = String(Date.now());
    const now = Date.now();

    const event = {
        cameraKey: args.cameraKey,
        cameraName: args.cameraName || args.cameraKey,
        movement_key: movementKey,
        processing_state: 'completed',
        detection_status: 'static_event',
        detection_started_at: now,
        detection_ended_at: now,
        tags: [
            {
                class: 'aeroplane',
                event: args.event,
                trackId: args.trackId,
                maxProbability: 0,
                count: 1,
            },
        ],
        notes: `static_detection: airplane_${args.event}`,
        created: now,
        updated: now,
    };

    try {
        await movements.put(movementKey, event);
        console.log(`OK wrote ${args.event} for ${args.trackId} at key ${movementKey}`);
    } catch (e) {
        console.error('DB write failed:', e.message);
        process.exit(1);
    } finally {
        await db.close();
    }
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const val = argv[i + 1];
            out[key] = val;
            i++;
        }
    }
    return out;
}

main().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
});
