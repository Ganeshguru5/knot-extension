/**
 * How well a resume covers a job description, by keywords: the skills and
 * tools the posting names (from the list below, plus your resume's own
 * skills), and which of them your resume mentions.
 *
 * Runs in the extension (not injected), so it can import and be imported.
 */

/** Common skills, each with the spellings postings use. */
const SKILLS = [
  ["JavaScript", "javascript", "js", "es6"],
  ["TypeScript", "typescript", "ts"],
  ["Python", "python"],
  ["Java", "java"],
  ["Kotlin", "kotlin"],
  ["Swift", "swift"],
  ["Go", "golang"],
  ["Rust", "rust"],
  ["C++", "c++", "cpp"],
  ["C#", "c#", "csharp"],
  [".NET", ".net", "dotnet", "asp.net"],
  ["PHP", "php"],
  ["Ruby", "ruby", "rails", "ruby on rails"],
  ["Scala", "scala"],
  ["Dart", "dart"],
  ["SQL", "sql"],
  ["HTML", "html", "html5"],
  ["CSS", "css", "css3", "scss", "sass"],
  ["React", "react", "react.js", "reactjs"],
  ["React Native", "react native"],
  ["Next.js", "next.js", "nextjs"],
  ["Vue", "vue", "vue.js", "vuejs", "nuxt"],
  ["Angular", "angular"],
  ["Svelte", "svelte"],
  ["Redux", "redux"],
  ["Tailwind", "tailwind", "tailwindcss"],
  ["Node.js", "node", "node.js", "nodejs"],
  ["Express", "express.js", "expressjs"],
  ["NestJS", "nestjs", "nest.js"],
  ["Django", "django"],
  ["Flask", "flask"],
  ["FastAPI", "fastapi"],
  ["Spring", "spring boot", "spring framework"],
  ["Flutter", "flutter"],
  ["Android", "android"],
  ["iOS", "ios"],
  ["GraphQL", "graphql"],
  ["REST APIs", "restful", "rest api", "rest apis"],
  ["gRPC", "grpc"],
  ["Microservices", "microservices", "microservice"],
  ["PostgreSQL", "postgresql", "postgres"],
  ["MySQL", "mysql"],
  ["MongoDB", "mongodb", "mongo"],
  ["Redis", "redis"],
  ["DynamoDB", "dynamodb"],
  ["Elasticsearch", "elasticsearch", "opensearch"],
  ["Kafka", "kafka"],
  ["RabbitMQ", "rabbitmq"],
  ["AWS", "aws", "amazon web services"],
  ["Lambda", "lambda", "serverless"],
  ["GCP", "gcp", "google cloud"],
  ["Azure", "azure"],
  ["Firebase", "firebase"],
  ["Docker", "docker"],
  ["Kubernetes", "kubernetes", "k8s"],
  ["Terraform", "terraform"],
  ["CI/CD", "ci/cd", "cicd", "continuous integration"],
  ["GitHub Actions", "github actions"],
  ["Jenkins", "jenkins"],
  ["Git", "git"],
  ["Linux", "linux"],
  ["Testing", "unit testing", "jest", "vitest", "pytest", "cypress", "playwright", "tdd"],
  ["System design", "system design", "distributed systems", "scalability"],
  ["Data structures", "data structures", "algorithms"],
  ["Machine learning", "machine learning", "ml"],
  ["AI / LLMs", "llm", "llms", "generative ai", "genai", "openai", "langchain", "rag", "prompt engineering"],
  ["Deep learning", "deep learning", "pytorch", "tensorflow"],
  ["Pandas", "pandas", "numpy"],
  ["Spark", "apache spark", "pyspark"],
  ["Airflow", "airflow"],
  ["Figma", "figma"],
  ["Agile", "agile", "scrum"],
  ["Security", "oauth", "jwt", "owasp"],
  ["WebSockets", "websocket", "websockets", "socket.io"],
  ["Performance", "web performance", "core web vitals"],
  ["Accessibility", "accessibility", "a11y", "wcag"],
]

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Matches a term on its own, so "java" doesn't match "javascript" and "sql" doesn't match "mysql". */
const termPattern = (term) => new RegExp(`(?<![a-z0-9+#.])${escape(term.toLowerCase())}(?![a-z0-9+#])`, "g")

const countIn = (text, terms) => terms.reduce((sum, term) => sum + (text.match(termPattern(term))?.length ?? 0), 0)

/** Everything a resume says, as plain lowercase text. */
export function resumeText(resume) {
  const parts = [
    resume.title,
    resume.targetRole,
    resume.summary,
    ...(resume.skills ?? []),
    ...(resume.experience ?? []).flatMap((e) => [e.title, e.company, ...(e.highlights ?? [])]),
    ...(resume.education ?? []).flatMap((e) => [e.degree, e.school]),
    // LaTeX source without its commands.
    String(resume.latexSource ?? "").replace(/\\[a-zA-Z]+\*?/g, " ").replace(/[{}[\]%$&_^~]/g, " "),
  ]
  return parts.filter(Boolean).join(" \n ").toLowerCase()
}

/**
 * `{ score, matched: [name], missing: [name] }` for `resume` against a job
 * description, or undefined when the description names no keywords.
 */
export function matchResume(resume, description) {
  const job = String(description ?? "").toLowerCase()
  if (!resume || job.length < 40) return undefined

  const candidates = new Map()
  for (const [name, ...terms] of SKILLS) candidates.set(name.toLowerCase(), { name, terms })
  // Your own skills count too, when the posting names them.
  for (const skill of resume.skills ?? []) {
    const name = String(skill).trim()
    if (name.length > 1 && name.length < 40 && !candidates.has(name.toLowerCase())) {
      candidates.set(name.toLowerCase(), { name, terms: [name] })
    }
  }

  const wanted = [...candidates.values()]
    .map((skill) => ({ ...skill, count: countIn(job, skill.terms) }))
    .filter((skill) => skill.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
  if (!wanted.length) return undefined

  const text = resumeText(resume)
  const matched = []
  const missing = []
  for (const skill of wanted) (countIn(text, skill.terms) ? matched : missing).push(skill.name)
  return { score: Math.round((matched.length / wanted.length) * 100), matched, missing }
}
