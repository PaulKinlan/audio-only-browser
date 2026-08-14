import { CDPClient } from "./cdp.ts";

let chromeProc: Deno.ChildProcess | null = null;
let cdp: CDPClient = new CDPClient();
let lastDomState: any = null;
let updatesQueue: string[] = [];

async function launchChrome() {
    console.log("Launching Chrome...");
    const command = new Deno.Command("google-chrome-stable", {
        args: [
            "--headless=new",
            "--remote-debugging-port=9222",
            "--disable-gpu",
            "--no-sandbox"
        ],
        stderr: "piped",
    });
    chromeProc = command.spawn();
    
    // Read stderr to find the ws:// url
    const reader = chromeProc.stderr.getReader();
    const decoder = new TextDecoder();
    let wsUrl = "";
    
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const match = text.match(/ws:\/\/[^\s]+/);
        if (match) {
            wsUrl = match[0];
            break;
        }
    }
    console.log("Found WS URL:", wsUrl);
    await cdp.connect(wsUrl);
    console.log("Connected to CDP!");

    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");

    // Listen to DOM updates
    cdp.on("DOM.documentUpdated", async () => {
        // Evaluate logic to find what changed, for simplicity we push a generic update
        // We could diff, but for now we'll just evaluate and see if new content exists
        const structure = await extractStructure();
        updatesQueue.push("Something changed on the page. New state summarized if requested.");
    });
}

// Ensure chrome shuts down
globalThis.addEventListener("unload", () => {
    chromeProc?.kill();
});

async function extractStructure() {
    // We execute a script in the page to extract headings, links, forms, buttons
    const expression = `
        (() => {
            const getTitle = () => document.title;
            const links = Array.from(document.querySelectorAll('a')).map(a => ({ text: a.innerText, href: a.href }));
            const buttons = Array.from(document.querySelectorAll('button')).map(b => b.innerText);
            const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.innerText);
            return JSON.stringify({ title: getTitle(), headings, links, buttons });
        })()
    `;
    const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (res.result && res.result.value) {
        return JSON.parse(res.result.value);
    }
    return { title: "", headings: [], links: [], buttons: [] };
}

function generateNarration(structure: any) {
    // Simple heuristic. An LLM could replace this to summarize "next steps" based on relevance.
    let narration = `You are on ${structure.title}. `;
    if (structure.headings.length > 0) {
        narration += `Main topic is ${structure.headings[0]}. `;
    }
    const actions = [];
    if (structure.links.length > 0) {
        actions.push(`You can follow links like: ${structure.links.slice(0,2).map((l: any) => l.text).join(", ")}`);
    }
    if (structure.buttons.length > 0) {
        actions.push(`or press buttons like: ${structure.buttons.slice(0,2).join(", ")}`);
    }
    if (actions.length > 0) {
        narration += `Next steps: ${actions.join(", ")}.`;
    }
    return narration;
}

const PORT = 9090;
Deno.serve({ port: PORT }, async (req: Request) => {
    const url = new URL(req.url);
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    // CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { 
            headers: { 
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            } 
        });
    }

    if (url.pathname === "/session" && req.method === "POST") {
        const { targetUrl } = await req.json();
        await cdp.send("Page.navigate", { url: targetUrl });
        
        // Wait briefly for load (in real app, wait for Page.loadEventFired)
        await new Promise(r => setTimeout(r, 1000));
        
        const structure = await extractStructure();
        const narration = generateNarration(structure);
        
        return new Response(JSON.stringify({ narration }), { headers });
    }

    if (url.pathname === "/intent" && req.method === "POST") {
        const { action } = await req.json();
        // Naive intent resolution: check if action matches link text or button text
        // In a real system, an LLM handles this mapping.
        
        const expression = `
            (() => {
                const actionText = "${action.toLowerCase()}";
                const links = Array.from(document.querySelectorAll('a'));
                for (const a of links) {
                    if (actionText.includes(a.innerText.toLowerCase())) {
                        a.click();
                        return "Clicked link: " + a.innerText;
                    }
                }
                const buttons = Array.from(document.querySelectorAll('button'));
                for (const b of buttons) {
                    if (actionText.includes(b.innerText.toLowerCase())) {
                        b.click();
                        return "Clicked button: " + b.innerText;
                    }
                }
                return "Could not understand action.";
            })()
        `;
        
        const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
        const resultMsg = res.result?.value || "Error";
        
        // Wait briefly to allow navigation/dom updates
        await new Promise(r => setTimeout(r, 1000));
        
        const structure = await extractStructure();
        const narration = generateNarration(structure);
        
        return new Response(JSON.stringify({ 
            result: resultMsg,
            narration: resultMsg.startsWith("Could not") ? resultMsg : `Action successful. ${narration}`
        }), { headers });
    }

    if (url.pathname === "/updates" && req.method === "GET") {
        // simple polling endpoint for demo
        const updates = [...updatesQueue];
        updatesQueue = [];
        return new Response(JSON.stringify({ updates }), { headers });
    }

    return new Response("Not found", { status: 404, headers });
});

await launchChrome();
