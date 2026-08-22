import type * as Monaco from "monaco-editor"

interface MonacoLoader {
  config: (options: { monaco: typeof Monaco }) => void
}

type MonacoWorkerScope = typeof self & {
  MonacoEnvironment?: {
    getWorker: (moduleId: string, label: string) => Worker
  }
}

let configuredModule: Promise<typeof import("@monaco-editor/react")> | null = null

export function configureMonacoLoader(loader: MonacoLoader, monaco: typeof Monaco): void {
  loader.config({ monaco })
}

function configureMonacoWorkers(): void {
  const workerScope = self as MonacoWorkerScope
  if (workerScope.MonacoEnvironment?.getWorker) return

  workerScope.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === "json") {
        return new Worker(new URL("monaco-editor/language/json/json.worker", import.meta.url), { type: "module" })
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(new URL("monaco-editor/language/css/css.worker", import.meta.url), { type: "module" })
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(new URL("monaco-editor/language/html/html.worker", import.meta.url), { type: "module" })
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(new URL("monaco-editor/language/typescript/ts.worker", import.meta.url), { type: "module" })
      }
      return new Worker(new URL("monaco-editor/editor/editor.worker", import.meta.url), { type: "module" })
    },
  }
}

async function loadConfiguredModule(): Promise<typeof import("@monaco-editor/react")> {
  if (!configuredModule) {
    configuredModule = (async () => {
      configureMonacoWorkers()
      const [reactModule, monaco] = await Promise.all([
        import("@monaco-editor/react"),
        import("monaco-editor"),
      ])
      configureMonacoLoader(reactModule.loader, monaco)
      return reactModule
    })()
  }

  return configuredModule
}

export async function loadMonacoEditor(): Promise<(typeof import("@monaco-editor/react"))["default"]> {
  return (await loadConfiguredModule()).default
}

export async function loadMonacoDiffEditor(): Promise<(typeof import("@monaco-editor/react"))["DiffEditor"]> {
  return (await loadConfiguredModule()).DiffEditor
}
