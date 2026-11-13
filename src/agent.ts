import { createAgent, registerTools } from "@ui-sdk/react/agent";

const agent = createAgent({
  allow: (step) => !step.confirm,
});

const unregister = registerTools(agent, {
  allow: () => true,
});

if (import.meta.hot) {
  import.meta.hot.dispose(unregister);
}

export { agent };
