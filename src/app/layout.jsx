import "./globals.css";

export const metadata = {
  title: "DialDesk · AI Training & Certification",
  description: "DialDesk - AI-powered agent training, voice certification and proctored process knowledge tests.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-full bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
