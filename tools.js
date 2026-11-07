import fs from 'fs';
import path from 'path';

// 1. The "Manual" sent to Ollama
export const novaTools = [
    {
        type: "function",
        function: {
            name: "list_directory",
            description: "List the contents of a directory in the user's project. Use this to explore the file system.",
            parameters: {
                type: "object",
                properties: {
                    dir_path: {
                        type: "string",
                        description: "The relative path to the directory (e.g., '.', 'src', 'src/components'). Use '.' for the root project directory."
                    }
                },
                required: ["dir_path"]
            }
        }
    }
];

// 2. The Execution Engine that runs when calling a tool
export function executeTool(toolCall, projectRoot) {
    const { name, arguments: args } = toolCall.function;
    
    if (name === "list_directory") {
        try {
            const targetPath = path.resolve(projectRoot, args.dir_path || '.');
            if (!targetPath.startsWith(path.resolve(projectRoot))) {
                return JSON.stringify({ error: "Access denied. Cannot read outside the project root." });
            }

            const items = fs.readdirSync(targetPath, { withFileTypes: true });
            
            const result = items
                .filter(item => !['node_modules', '.git', '.env'].includes(item.name))
                .map(item => `${item.isDirectory() ? '[DIR]' : '[FILE]'} ${item.name}`);
                
            return JSON.stringify({ 
                directory: args.dir_path || '.', 
                contents: result.length ? result : "Empty directory" 
            });

        } catch (error) {
            return JSON.stringify({ error: `Failed to read directory: ${error.message}` });
        }
    }
    
    return JSON.stringify({ error: `Tool '${name}' not found.` });
}