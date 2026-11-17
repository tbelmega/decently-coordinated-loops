// Installs the operating guide into this machine's harness configs. install.sh runs it on
// every install; it needs no data repo. Exits 0 even when a file's tags are malformed:
// that file is reported and left untouched, as the board seeder does.
import { homedir } from "node:os";
import { installGuide } from "./guide.ts";

console.log("Installing the operating guide:");
installGuide(homedir());
