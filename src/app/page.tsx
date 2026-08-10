const approvalGates = [
  {
    label: "Gate 01",
    title: "Topic approval",
    detail:
      "Research and drafting begin only after explicit Telegram approval.",
  },
  {
    label: "Gate 02",
    title: "Final article approval",
    detail:
      "Publishing remains blocked until the completed article is approved in Telegram.",
  },
] as const;

export default function Home() {
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Repository foundation · Milestone 0</p>
        <h1 id="page-title">AI Content Machine</h1>
        <p className="lede">
          A small editorial system designed to find worthwhile technology
          stories, build source-backed drafts, and keep publication under human
          control.
        </p>
      </section>

      <section className="gates" aria-labelledby="gates-title">
        <div>
          <p className="eyebrow">Non-negotiable workflow</p>
          <h2 id="gates-title">Two decisions stay human.</h2>
        </div>
        <ol>
          {approvalGates.map((gate) => (
            <li key={gate.label}>
              <span>{gate.label}</span>
              <h3>{gate.title}</h3>
              <p>{gate.detail}</p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
