/**
 * The notebook, as one process-wide instance.
 *
 * A `Map`, and that is honest for what it is: a fixture of three notes so the example has something to read and
 * write without a schema for it. It is **not** where anything durable lives — principal memory is a real table
 * (#164), and a note the model writes does not survive a restart, which the README says.
 *
 * Module-level so the app module and the server share one notebook. Two instances would mean a note written
 * through a tool being invisible to the page, which looks exactly like a persistence bug.
 */

import { createExampleStore, type ExampleStore } from "./tools.js";

export const exampleStore: ExampleStore = createExampleStore();
