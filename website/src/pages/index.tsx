import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import styles from "./index.module.css";

const features = [
  {
    title: "Provider-neutral",
    body: "Run any model — OpenAI, Anthropic, Google, Mistral, Bedrock — behind one registry. Switch providers without touching agent or tool code.",
  },
  {
    title: "Durable by design",
    body: "Queued, checkpointed runs that survive refreshes and worker restarts, with cancellation, Claude-style retries, and idempotent external writes.",
  },
  {
    title: "Layered memory",
    body: "Session, user, and tenant memory under an explicit token budget — the assistant remembers what matters and never blows the context window.",
  },
  {
    title: "Safe tools & HITL",
    body: "Permission-filtered tool discovery, approval gates for external actions, and durable questions — the model can’t act without authorization.",
  },
  {
    title: "Knowledge & RAG",
    body: "Permission-aware hybrid retrieval with citations that resolve to exact source locations. Tenant isolation is enforced before search.",
  },
  {
    title: "Headless & reusable",
    body: "Ports-and-adapters everywhere, a headless React client, and an embedded profile — drop the platform into any app, or run it as a server.",
  },
];

export default function Home(): JSX.Element {
  return (
    <Layout title="Documentation" description="A reusable, provider-neutral AI agent platform">
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <h1 className={styles.heroTitle}>@agentkit</h1>
          <p className={styles.heroSubtitle}>
            A reusable, provider-neutral AI agent platform — durable runs, layered memory,
            safe tools, and permission-aware retrieval.
          </p>
          <div className={styles.heroButtons}>
            <Link className={styles.buttonPrimary} to="/docs/overview">
              Get started
            </Link>
            <Link className={styles.buttonSecondary} to="/api/">
              API reference
            </Link>
          </div>
        </div>
      </header>
      <main>
        <section className={styles.features}>
          {features.map((f) => (
            <div key={f.title} className={styles.card}>
              <h3 className={styles.cardTitle}>{f.title}</h3>
              <p className={styles.cardBody}>{f.body}</p>
            </div>
          ))}
        </section>
      </main>
    </Layout>
  );
}
