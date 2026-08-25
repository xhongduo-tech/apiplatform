import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { Components } from "react-markdown";

/** Strip YAML frontmatter (leading --- block) so it isn't rendered as <hr>. */
function stripFrontmatter(source: string): string {
  const m = source.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? source.slice(m[0].length) : source;
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-6 mb-2 font-serif text-2xl font-medium">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2 font-serif text-xl font-medium">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1 font-serif text-lg font-medium">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-1 font-serif text-base font-medium">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="my-2 text-sm leading-relaxed text-fg">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1.5 pl-6">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1.5 pl-6">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="pl-1 text-sm leading-relaxed text-fg">{children}</li>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-brand underline decoration-transparent underline-offset-2 transition hover:decoration-current"
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-bg-soft px-1 font-mono text-[0.85em]"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-bg-soft p-3 font-mono text-sm">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b-2 border-border">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 border-b border-border">{children}</td>
  ),
  img: ({ src, alt }) => (
    <img src={src} alt={alt} className="my-3 max-w-full h-auto rounded" />
  ),
  hr: () => <hr className="my-6 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-4 text-fg-muted">
      {children}
    </blockquote>
  ),
  del: ({ children }) => (
    <del className="line-through">{children}</del>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic">{children}</em>
  ),
};

export function Markdown({ source }: { source: string }) {
  const clean = stripFrontmatter(source).trim();
  if (!clean) return null;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // rehypeRaw 把 markdown 源文本里内嵌的原始 HTML 解析进渲染树；论坛帖子/
      // 回复内容是用户自由文本，未经任何清洗直接进这条管线，rehypeSanitize
      // 必须紧跟其后按白名单剥掉 <script>/on* 事件/javascript: 协议等——顺序
      // 不能换：sanitize 只清洗它看到的树，得在 raw 把 HTML 解析进树之后再跑。
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={components}
    >
      {clean}
    </ReactMarkdown>
  );
}
