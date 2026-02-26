// Minimal SDK test - run inside container with: deno run --allow-all test-sdk.ts
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";

console.log("Starting minimal SDK test...");
console.log("SDK imported successfully");

try {
    const iterator = claudeQuery({
        prompt: "Say hello in one word",
        abortController: new AbortController(),
        options: {
            cwd: "/workspace",
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
        },
    });

    console.log("Iterator created:", typeof iterator);
    console.log("Waiting for messages...");

    let count = 0;
    for await (const message of iterator) {
        count++;
        console.log(`Message ${count}:`, JSON.stringify(message).substring(0, 200));
        if (count >= 5) {
            console.log("(stopping after 5 messages)");
            break;
        }
    }

    console.log(`Total messages received: ${count}`);
} catch (error) {
    console.error("SDK Error:", error);
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    if (error.stack) console.error("Stack:", error.stack);
}
