/**
 * The landing-page building blocks — the five letters, the workflow, card grids — shared by the
 * home page and the "What is BFAST?" doc so the two can never tell the story differently.
 */
import {useState, type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Heading from '@theme/Heading';

import styles from './styles.module.css';

export type Letter = 'B' | 'F' | 'A' | 'S' | 'T';

type Part = {
  letter: Letter;
  word: string;
  role: string;
  body: string;
  long: string;
  where: string[];
  why: string;
  to: string;
};

export const PARTS: Part[] = [
  {
    letter: 'B',
    word: 'Backend',
    role: 'The services, data and logic a ticket changes',
    body: 'Design the data beside the ticket, then build it on a disposable stack of its own.',
    long: 'The part nobody sees and everything depends on. Each story or epic runs its own disposable stack on its own git worktree, so two pieces of work never share a database by accident. Designs sit beside the ticket, so the shape of the data is decided before the code is written.',
    where: ['Environments', 'Design documents', 'Implement'],
    why: 'A backend change is the hardest to undo once data depends on it.',
    to: '/docs/guides/environments',
  },
  {
    letter: 'F',
    word: 'Frontend',
    role: 'What a user actually sees and does',
    body: 'Stories are written from the user’s side, and every acceptance criterion is a behaviour a user can observe.',
    long: 'Where a ticket’s promise is kept or broken. A story is written as “As a … I want … So that …”, every acceptance criterion describes something a user can observe, and browser tests file a video and a trace of each run.',
    where: ['Acceptance criteria', 'Browser tests', 'Port preview'],
    why: 'A feature the user cannot use is not done.',
    to: '/docs/guides/tickets',
  },
  {
    letter: 'A',
    word: 'Assurance',
    role: 'Proof that the work does what the ticket says',
    body: 'One run per test case, with its output, video and trace kept — and the status moves on the verdict.',
    long: 'Proof, not hope. Every criterion is broken into test cases; each run keeps its output, video and trace and moves the ticket to done or blocked. An AI answer over existing text is a diff you approve, never written silently.',
    where: ['Test cases', 'Run Tests', 'Evidence', 'AI review'],
    why: '“It works on my machine” is not evidence.',
    to: '/docs/guides/run-tests',
  },
  {
    letter: 'S',
    word: 'Security',
    role: 'Keeping the code and the team’s secrets safe',
    body: 'Every story’s worktree is scanned before merge; keys live in secret storage, never in the repository.',
    long: 'Built in, not added at the end. A story’s worktree is scanned for vulnerabilities and code issues before merge. Keys and tokens live in VS Code’s secret storage, the AI runs with a short fixed list of tools, and the MCP server stays on your machine unless you choose otherwise.',
    where: ['Code scans', 'Secret storage', 'Tool limits'],
    why: 'A vulnerability costs far more after release than before merge.',
    to: '/docs/guides/code-quality',
  },
  {
    letter: 'T',
    word: 'Tracker',
    role: 'The record that ties the other four together',
    body: 'Every ticket is a folder of plain files, with a history, reviewed in the pull request next to the code.',
    long: 'The spine of the other four. Every ticket is a folder of plain files with a history of every change. It travels with the branch, is reviewed next to the code, and still reads without BFAST installed.',
    where: ['Tickets as files', 'History', 'The board'],
    why: 'Without a shared record, the other four drift apart.',
    to: '/docs/guides/tickets',
  },
];

type Step = {
  title: string;
  letters: Letter[];
  body: string;
  image: string;
  alt: string;
  to: string;
  link: string;
};

const STEPS: Step[] = [
  {
    title: 'Plan',
    letters: ['T'],
    body: 'Create an epic and let the AI break it down into stories, acceptance criteria and test cases. Nothing is written until you have reviewed the list.',
    image: 'img/screens/generate-review.png',
    alt: 'The generate tab showing a proposed list of stories to tick through',
    to: '/docs/guides/generate',
    link: 'Break a ticket down',
  },
  {
    title: 'Design',
    letters: ['B'],
    body: 'Draw the entity-relationship diagram, the sequence diagram or a low level design in a tab beside the story it belongs to.',
    image: 'img/screens/design-erd.png',
    alt: 'An entity-relationship diagram in a design tab on a story board',
    to: '/docs/guides/design-documents',
    link: 'Design documents',
  },
  {
    title: 'Build',
    letters: ['B', 'F'],
    body: 'Start a disposable environment on the story’s own worktree and ports, then hand the ticket to a coding agent as a prepared prompt.',
    image: 'img/screens/env-running.png',
    alt: 'The Environments section with a running environment and its ports',
    to: '/docs/guides/environments',
    link: 'Environments',
  },
  {
    title: 'Verify',
    letters: ['A', 'F'],
    body: 'Run every test case under the ticket. Output, video and Playwright trace are filed per run, and the ticket moves to done or blocked.',
    image: 'img/screens/tests-tab.png',
    alt: 'The Tests tab on a board with test runs and their results',
    to: '/docs/guides/run-tests',
    link: 'Run tests',
  },
  {
    title: 'Secure',
    letters: ['S'],
    body: 'Scan the story’s worktree for vulnerabilities and code issues before it is merged. The result is recorded on the ticket.',
    image: 'img/screens/scan-results.png',
    alt: 'The scan results tab for a story',
    to: '/docs/guides/code-quality',
    link: 'Code quality',
  },
  {
    title: 'Ship',
    letters: ['T'],
    body: 'Every change — by a person, the AI or a test run — is in the ticket’s history. Commit the ticket with the code and review both in one pull request.',
    image: 'img/screens/board-history.png',
    alt: 'The history of a ticket on its board',
    to: '/docs/guides/board',
    link: 'The board',
  },
];

function Badge({letter}: {letter: Letter}) {
  return <span className={clsx(styles.badge, styles[`l${letter}`])}>{letter}</span>;
}

/** Backend · Frontend · Assurance · Security · Tracker, each initial in its own colour. */
export function Acronym({className}: {className?: string}) {
  return (
    <p
      className={clsx(styles.landing, styles.acronym, className)}
      aria-label="Backend, Frontend, Assurance, Security, Tracker">
      {PARTS.map((p) => (
        <span key={p.letter}>
          <b className={styles[`t${p.letter}`]}>{p.letter}</b>
          {p.word.slice(1)}
        </span>
      ))}
    </p>
  );
}

/** A banner for the top of a doc page: logo, the acronym and a lead sentence. */
export function Banner({children}: {children: ReactNode}) {
  return (
    <div className={clsx(styles.landing, styles.banner)}>
      <img className={styles.bannerLogo} src={useBaseUrl('img/logo.svg')} alt="" />
      <Acronym />
      <div className={styles.bannerLead}>{children}</div>
    </div>
  );
}

/** The five parts as cards. `detailed` swaps the one-liner for the longer text and the features. */
export function Parts({detailed = false}: {detailed?: boolean}) {
  if (detailed) {
    // One row per letter: five cards never divide evenly into columns, rows always do.
    return (
      <div className={clsx(styles.landing, styles.rows)}>
        {PARTS.map((p) => (
          <Link key={p.letter} to={p.to} className={clsx(styles.part, styles.row, styles[`p${p.letter}`])}>
            <span className={styles.rowSide}>
              <span className={styles.partLetter}>{p.letter}</span>
              <span className={styles.partWord}>{p.word}</span>
            </span>
            <span className={styles.rowMain}>
              <span className={styles.partRole}>{p.role}</span>
              <span className={styles.partBody}>{p.long}</span>
              <span className={styles.rowFoot}>
                <span className={styles.chips}>
                  {p.where.map((w) => (
                    <span key={w} className={styles.chip}>
                      {w}
                    </span>
                  ))}
                </span>
                <span className={styles.rowWhy}>{p.why}</span>
              </span>
            </span>
          </Link>
        ))}
      </div>
    );
  }
  return (
    <div className={clsx(styles.landing, styles.parts)}>
      {PARTS.map((p) => (
        <Link key={p.letter} to={p.to} className={clsx(styles.part, styles[`p${p.letter}`])}>
          <span className={styles.partHead}>
            <span className={styles.partLetter}>{p.letter}</span>
            <span className={styles.partWord}>{p.word}</span>
          </span>
          <span className={styles.partRole}>{p.role}</span>
          <span className={styles.partBody}>{p.body}</span>
          <span className={styles.partWhy}>{p.why}</span>
        </Link>
      ))}
    </div>
  );
}

/** The six steps a ticket goes through, with a screenshot of the chosen one. */
export function Workflow() {
  const [active, setActive] = useState(0);
  const step = STEPS[active];
  const src = useBaseUrl(step.image);
  return (
    <div className={styles.landing}>
      <ol className={styles.pipeline}>
        {STEPS.map((s, i) => (
          <li key={s.title} className={styles.pipeItem}>
            <button
              type="button"
              className={clsx(styles.pipeStep, i === active && styles.pipeActive)}
              aria-pressed={i === active}
              onClick={() => setActive(i)}>
              <span className={styles.pipeNum}>{i + 1}</span>
              <span className={styles.pipeTitle}>{s.title}</span>
              <span className={styles.badges}>
                {s.letters.map((l) => (
                  <Badge key={l} letter={l} />
                ))}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className={styles.loopNote}>
        A failed test moves the ticket to <b>blocked</b>, and the work goes back to <b>Build</b>{' '}
        until it passes.
      </p>
      <div className={styles.stage}>
        <div className={styles.stageText}>
          <span className={styles.stageNum}>
            Step {active + 1} of {STEPS.length}
          </span>
          <Heading as="h3" className={styles.stageTitle}>
            {step.title}
          </Heading>
          <div className={styles.stageParts}>
            {step.letters.map((l) => (
              <span key={l} className={styles.stagePart}>
                <Badge letter={l} /> {PARTS.find((p) => p.letter === l)!.word}
              </span>
            ))}
          </div>
          <p>{step.body}</p>
          <Link to={step.to}>Read the guide: {step.link} →</Link>
        </div>
        <div className={styles.stageShot}>
          <img src={src} alt={step.alt} loading="lazy" />
        </div>
      </div>
    </div>
  );
}

export type Card = {
  title: string;
  body: ReactNode;
  to?: string;
  /** A letter of BFAST, a number, or a short mark shown above the title. */
  mark?: string;
  letter?: Letter;
};

/** A grid of cards; a card with `to` is a link. */
export function Cards({items, columns = 3}: {items: Card[]; columns?: 2 | 3}) {
  return (
    <div className={clsx(styles.landing, styles.cards, columns === 2 && styles.cards2)}>
      {items.map((c) => {
        const inner = (
          <>
            {(c.mark || c.letter) && (
              <span className={styles.cardMark}>
                {c.letter ? <Badge letter={c.letter} /> : c.mark}
              </span>
            )}
            <span className={styles.cardTitle}>{c.title}</span>
            <span className={styles.cardBody}>{c.body}</span>
            {c.to && <span className={styles.cardMore}>Read more →</span>}
          </>
        );
        return c.to ? (
          <Link key={c.title} to={c.to} className={clsx(styles.card, styles.cardLink)}>
            {inner}
          </Link>
        ) : (
          <div key={c.title} className={styles.card}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
