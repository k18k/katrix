/**
 * Event shapes (https://spec.matrix.org/v1.16/client-server-api/#events), typed by event type.
 * EventContentMap is an interface, so an app can add its own types by declaration merging:
 *
 *   declare module "@katrix/client" {
 *     interface EventContentMap { "com.example.poll": { question: string } }
 *   }
 */
export {};
