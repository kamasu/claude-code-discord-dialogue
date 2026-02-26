// Test SDK with fork-like options — run: deno run --allow-all test-sdk.ts
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";

console.log("=== SDK Test with fork-like options ===\n");

// Test 1: Basic (already works)
async function test1() {
    console.log("--- Test 1: Basic query (control) ---");
    try {
        let count = 0;
        for await (const msg of claudeQuery({
            prompt: "Say hi",
            abortController: new AbortController(),
            options: {
                cwd: "/workspace",
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
            },
        })) {
            count++;
            if (count >= 5) break;
        }
        console.log(`Result: ${count} messages ✓\n`);
    } catch (e) {
        console.log(`Error: ${e.message}\n`);
    }
}

// Test 2: With systemPrompt
async function test2() {
    console.log("--- Test 2: + systemPrompt ---");
    try {
        let count = 0;
        for await (const msg of claudeQuery({
            prompt: "Say hi",
            abortController: new AbortController(),
            options: {
                cwd: "/workspace",
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                systemPrompt: { type: 'preset', preset: 'claude_code' },
                settingSources: ['project', 'local'],
            },
        })) {
            count++;
            if (count >= 5) break;
        }
        console.log(`Result: ${count} messages ✓\n`);
    } catch (e) {
        console.log(`Error: ${e.message}\n`);
    }
}

// Test 3: With canUseTool callback
async function test3() {
    console.log("--- Test 3: + canUseTool callback ---");
    try {
        let count = 0;
        for await (const msg of claudeQuery({
            prompt: "Say hi",
            abortController: new AbortController(),
            options: {
                cwd: "/workspace",
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                canUseTool: async (toolName: string, input: Record<string, unknown>) => {
                    console.log(`  [canUseTool] ${toolName}`);
                    return { behavior: 'allow' as const, updatedInput: input };
                },
            },
        })) {
            count++;
            if (count >= 5) break;
        }
        console.log(`Result: ${count} messages ✓\n`);
    } catch (e) {
        console.log(`Error: ${e.message}\n`);
    }
}

// Test 4: With MCP servers
async function test4() {
    console.log("--- Test 4: + mcpServers ---");
    try {
        const mcpServers = {
            discord: {
                type: "url" as const,
                url: "http://mcp-discord:3000/mcp",
            },
        };
        let count = 0;
        for await (const msg of claudeQuery({
            prompt: "Say hi",
            abortController: new AbortController(),
            options: {
                cwd: "/workspace",
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                mcpServers,
            },
        })) {
            count++;
            if (count >= 5) break;
        }
        console.log(`Result: ${count} messages ✓\n`);
    } catch (e) {
        console.log(`Error: ${e.message}\n`);
    }
}

// Run all tests sequentially
await test1();
await test2();
await test3();
await test4();

console.log("=== All tests complete ===");
