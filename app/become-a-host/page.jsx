import Link from "next/link";
import "../beta/beta.css";

export const metadata = {
  title: "Become a host · Human Connection",
  description: "Explore hosting short, platonic conversations through Human Connection.",
};

export default function BecomeAHostPage() {
  return (
    <div className="beta-shell">
      <header className="beta-header">
        <Link className="beta-brand" href="/beta">human<span>connection.</span></Link>
      </header>
      <main>
        <h1>Become a host</h1>
        <p>Share funny stories, listen to someone’s day, or play a short conversation game.</p>
        <section className="beta-card" aria-labelledby="host-application-steps">
          <h2 id="host-application-steps">How to apply</h2>
          <ol>
            <li>Sign in with your Human Connection account.</li>
            <li>Tell us about your conversation styles, topics and spoken languages.</li>
            <li>Submit your profile, then add a photo and short introduction for review.</li>
          </ol>
          <p>Hosts must be adults in the United States. Identity, training and experience checks apply before booking eligibility.</p>
          <p>The marketplace is in a staging preview. Host applications here are for testing.</p>
          <Link className="beta-primary" href="/host/login">Open the host application</Link>
        </section>
      </main>
    </div>
  );
}
