import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import {Acronym, Parts, Workflow} from '@site/src/components/Landing';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={styles.hero}>
      <div className={clsx('container', styles.heroInner)}>
        <img className={styles.heroLogo} src={useBaseUrl('img/logo.svg')} alt="" />
        <Heading as="h1" className={styles.heroTitle}>
          {siteConfig.title}
        </Heading>
        <Acronym className={styles.heroAcronym} />
        <p className={styles.heroTagline}>{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/getting-started/quick-start">
            Get started
          </Link>
          <Link className="button button--secondary button--lg" to="/docs/intro">
            What is BFAST?
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title="Backend, Frontend, Assurance, Security, Tracker" description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <section className={styles.section}>
          <div className="container">
            <Heading as="h2" className={styles.sectionTitle}>
              Five parts, one ticket
            </Heading>
            <p className={styles.sectionLead}>
              Each letter of BFAST names a part of delivering software. A ticket is finished only
              when all five agree on it.
            </p>
            <Parts />
          </div>
        </section>
        <section className={clsx(styles.section, styles.sectionAlt)}>
          <div className="container">
            <Heading as="h2" className={styles.sectionTitle}>
              How a ticket moves through BFAST
            </Heading>
            <p className={styles.sectionLead}>
              From an idea, through controlled steps, to a finished product — in the editor you
              already use. Pick a step to see it.
            </p>
            <Workflow />
          </div>
        </section>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
