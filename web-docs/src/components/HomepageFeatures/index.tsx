import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';

type FeatureItem = {
  title: string;
  to: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Tickets are files',
    to: '/docs/guides/tickets',
    description: (
      <>
        Epic → story → acceptance criterion → test case, one folder each. They
        review in a pull request and travel with a branch.
      </>
    ),
  },
  {
    title: 'A board per ticket',
    to: '/docs/guides/board',
    description: (
      <>
        An editor tab with a markdown description, images, an append-only
        history, test runs and design documents.
      </>
    ),
  },
  {
    title: 'AI assistant',
    to: '/docs/guides/ai-assistant',
    description: (
      <>
        Write and refine descriptions with roles and skills you own as files.
        Every answer is reviewed as a diff before it replaces your text.
      </>
    ),
  },
  {
    title: 'Break tickets down',
    to: '/docs/guides/generate',
    description: (
      <>
        Generate stories, acceptance criteria and test cases. Nothing is
        created until you have seen — and edited — the list.
      </>
    ),
  },
  {
    title: 'Design documents',
    to: '/docs/guides/design-documents',
    description: (
      <>
        ERDs, sequence diagrams and low level designs as Mermaid, in a tab
        beside the ticket they belong to.
      </>
    ),
  },
  {
    title: 'Environments',
    to: '/docs/guides/environments',
    description: (
      <>
        One disposable Docker Compose stack per story or epic, on its own git
        worktree and its own ports.
      </>
    ),
  },
  {
    title: 'Run tests',
    to: '/docs/guides/run-tests',
    description: (
      <>
        One command per test case. Verdicts move the ticket; videos and
        Playwright traces play on the board.
      </>
    ),
  },
  {
    title: 'Code quality',
    to: '/docs/guides/code-quality',
    description: (
      <>
        Scan a story's worktree for vulnerabilities and code issues, on a
        server deployed for you or one you already have. The result lands in
        the ticket history.
      </>
    ),
  },
  {
    title: 'Implement and MCP',
    to: '/docs/guides/implement',
    description: (
      <>
        Hand a ticket to a coding agent as a ready prompt, and let agents read
        and update the tracker over the built-in MCP server.
      </>
    ),
  },
];

function Feature({title, to, description}: FeatureItem) {
  return (
    <div className="col col--4 margin-bottom--lg">
      <div className="card padding--md" style={{height: '100%'}}>
        <Heading as="h3">
          <Link to={to}>{title}</Link>
        </Heading>
        <p className="margin-bottom--none">{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className="padding-vert--xl">
      <div className="container">
        <Heading as="h2" className="text--center margin-bottom--lg">
          Everything in the box
        </Heading>
        <div className="row">
          {FeatureList.map((props) => (
            <Feature key={props.title} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
