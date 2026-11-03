import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
/**
 * JSON Lines files: `{directory}/{room ID}/{YYYY-MM-DD}.jsonl`, one file per room and UTC day of
 * the event. Room IDs are percent-encoded, so they cannot name a path outside the directory.
 */
export function fileSink(directory) {
    return {
        async write(records) {
            const byFile = new Map();
            for (const r of records) {
                const file = join(directory, encodeURIComponent(r.room_id), `${day(r.origin_server_ts)}.jsonl`);
                byFile.set(file, [...(byFile.get(file) ?? []), JSON.stringify(r)]);
            }
            for (const [file, lines] of byFile) {
                await mkdir(join(file, ".."), { recursive: true });
                await appendFile(file, `${lines.join("\n")}\n`);
            }
        },
    };
}
/** Records kept in memory (tests, or a custom forwarder that reads `records`). */
export function memorySink() {
    const records = [];
    return {
        records,
        async write(batch) {
            records.push(...batch);
        },
    };
}
