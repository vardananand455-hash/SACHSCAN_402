# SACHSCAN — AI-Powered Digital Evidence Verification

SACHSCAN is an AI-assisted digital evidence analysis platform designed to help users investigate potentially manipulated images, videos, and documents. It combines AI-based analysis, web source discovery, metadata inspection, evidence management, and blockchain-enabled pay-per-analysis payments.

The goal is to help users examine digital content, discover relevant online sources, and organize findings in one place.

> **Disclaimer:** SACHSCAN provides investigative assistance, not a definitive guarantee of authenticity. AI-generated-content detection and web source discovery can produce incomplete or inaccurate results.

## ✨ Features

- **AI-Powered Analysis:** Integrates an AI detector to help assess whether digital content may be AI-generated or manipulated.
- **Source Trace:** Uses the TinyFish API integration for web source discovery and relevant page retrieval to assist investigations.
- **Evidence Management:** Supports evidence uploads and investigation records through Supabase.
- **Metadata Inspection:** Helps examine available file metadata when supported by the implemented analysis workflow.
- **Investigation Dashboard:** Organizes investigation details, findings, and analysis results.
- **Pay-per-Analysis:** Integrates the x402 payment protocol to support payment-gated analysis workflows.
- **Algorand Testnet:** Uses Algorand's test network for blockchain-related payment demonstrations.
- **Pera Wallet:** Supports wallet-based interaction where implemented in the payment flow.
- **GoPlausible Facilitator:** Configures the x402 payment facilitator for payment processing.
- **Supabase Backend:** Provides database, storage, and application backend capabilities.

## 🧰 Technology Stack

| Technology | Purpose |
|---|---|
| React | User interface |
| TypeScript | Type-safe application development |
| Vite | Development server and build tooling |
| Tailwind CSS | Styling |
| Supabase | Database, storage, and backend services |
| TinyFish API | Web source discovery and page retrieval |
| AI Detector API | AI-generated-content detection integration |
| Sightengine API | Image/video analysis integration, where configured |
| x402 | HTTP-based payment protocol integration |
| Algorand | Blockchain payment demonstration on Testnet |
| Pera Wallet | Wallet interaction |
| GoPlausible | x402 facilitator integration |

*The exact technologies used by individual features depend on their current implementation and configuration.*

## 🏗️ How SACHSCAN Works

1. **Submit Evidence:** The user uploads or selects supported digital evidence.
2. **Run Analysis:** The application invokes the configured analysis services to obtain available results.
3. **Trace Online Sources:** Source Trace uses the TinyFish integration to discover relevant web pages and retrieve information that may help with investigation.
4. **Review Findings:** The user reviews the returned results, metadata, and investigation information available in the interface.
5. **Access Protected Features:** Where payment gating is enabled, the user completes the required x402 payment flow.
6. **Record Investigation Data:** The application uses Supabase to store supported investigation records and evidence.

The exact sequence may vary by feature and configuration.

## 🔎 TinyFish API Integration

TinyFish is used in SACHSCAN's Source Trace workflow to assist with web source discovery.

### What TinyFish Does

The integration is intended to help the application discover relevant web pages and retrieve source information that may provide context for an investigation.

Potential uses include:

- Discovering web pages relevant to a submitted investigation.
- Retrieving information from accessible pages.
- Finding potentially useful source URLs.
- Providing additional context for manual verification.
- Supporting the investigation workflow alongside AI analysis.

### What TinyFish Does Not Prove

TinyFish web source discovery should not be confused with pixel-based reverse-image search.

Finding a similar page, matching text, or a relevant URL does **not** automatically prove that an image originated from that page or that the content is authentic. Search results may be incomplete, and websites may be inaccessible or changed.

SACHSCAN should present source discovery results as investigative leads rather than definitive proof.

### TinyFish Configuration

Add the TinyFish API key to your local environment file:

```env
TINYFISH_API_KEY=your_tinyfish_api_key
```

The key must remain on the server side. Do not expose it through frontend environment variables such as `VITE_TINYFISH_API_KEY`.

The application may use configured TinyFish API endpoints for search and page retrieval. Keep endpoint configuration and request handling aligned with the current TinyFish API documentation and the implementation in this repository.

### Recommended Integration Flow

1. Receive a source-tracing request from the application.
2. Validate the request on the server.
3. Retrieve the TinyFish API key from the server environment.
4. Call the configured TinyFish service using the required authentication and request format.
5. Handle API errors, inaccessible pages, and empty results.
6. Return relevant source information to the application.
7. Display source URLs and retrieved information for the user to review.

Never send the private TinyFish API key to the browser.

## 💳 x402 and Algorand Testnet

SACHSCAN includes an x402 payment integration intended to support pay-per-analysis functionality.

The payment workflow is designed around:

- **x402:** A payment protocol for HTTP-based payment-gated requests.
- **Algorand Testnet:** A test network for demonstrating blockchain payment interactions.
- **Pera Wallet:** Wallet interaction for supported payment operations.
- **GoPlausible Facilitator:** Facilitator configuration for the x402 payment flow.

### Intended Payment Flow

1. The user requests a protected analysis feature.
2. The application checks the payment requirement.
3. The user completes the required wallet-based payment process.
4. The configured facilitator participates in processing the payment flow.
5. The application verifies the payment according to its server-side implementation.
6. Access is granted only when the required payment verification succeeds.

Actual payment behavior depends on the implemented endpoints, network configuration, facilitator support, and payment verification logic.

**Important:** Testnet assets are for testing and demonstration, not equivalent to real-world funds. A successful payment demonstration should be verified using the appropriate Algorand Testnet explorer.

## 🗄️ Supabase Integration

Supabase provides backend capabilities for the application, including supported database and evidence-storage workflows.

Depending on the enabled features, Supabase can be used for:

- Storing investigation records.
- Managing evidence metadata.
- Storing supported uploaded files.
- Associating records with authenticated users.
- Applying access control through Row Level Security (RLS).

### Security Recommendations

- Enable RLS on tables containing user or investigation data.
- Use policies that restrict access to the appropriate user or authorized role.
- Keep service-role keys and other privileged credentials on the server.
- Validate uploads and enforce file-size and file-type restrictions.
- Do not rely on frontend checks alone to authorize sensitive operations.

## 🚀 Getting Started

### Prerequisites

Install the following before running the project:

- Node.js, using a version compatible with the project dependencies.
- npm.
- Git.
- A Supabase project.
- API credentials for the external services you intend to use.
- An Algorand Testnet wallet and facilitator configuration if testing x402 payments.

### 1. Clone the Repository

Replace the placeholder with your actual public GitHub repository URL.

```bash
git clone https://github.com/YOUR-USERNAME/SACHSCAN.git
cd SACHSCAN
```

### 2. Install Dependencies

```bash
npm install
```

If the repository uses another package manager, follow the lockfile and package-manager configuration included in the project.

### 3. Configure Environment Variables

Create a local `.env` file in the project root. Use the variables required by your actual application code.

Example template:

```env
# Supabase project configuration
SUPABASE_PROJECT_ID=your_project_id
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_publishable_key

# Vite frontend configuration
VITE_SUPABASE_PROJECT_ID=your_project_id
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key

# AI and media analysis services
AI_DETECTOR_API_KEY=your_ai_detector_api_key
SIGHTENGINE_API_USER=your_sightengine_api_user
SIGHTENGINE_API_SECRET=your_sightengine_api_secret

# TinyFish source discovery
TINYFISH_API_KEY=your_tinyfish_api_key

# x402 payment configuration
FACILITATOR_URL=https://facilitator.goplausible.xyz
X402_PAY_TO=your_testnet_payment_address
```

These are example placeholders, not working credentials. Confirm each variable name against the current source code and service configuration before running the application.

**Environment variable security:**

- Never commit `.env` files or actual API credentials.
- Do not use the `VITE_` prefix for private API secrets.
- Keep private API requests in server-side code.
- Supabase publishable keys may be used in frontend code when intended for that purpose, but database security must still be enforced with RLS.
- If an actual secret has already been exposed publicly, rotate or revoke it.

### 4. Start the Development Server

```bash
npm run dev
```

Open the local URL printed in your terminal, commonly:

```text
http://localhost:5173
```

### 5. Build for Production

```bash
npm run build
```

To preview the production build locally:

```bash
npm run preview
```

Use the scripts defined in `package.json` if they differ from these examples.

## 📁 Project Structure

The following is a high-level description of the expected project organization. Exact filenames and folders may vary.

```text
SACHSCAN/
├── public/             # Static assets
├── src/                # Frontend application
├── supabase/           # Supabase configuration and migrations
├── .gitignore          # Files excluded from Git
├── package.json        # Dependencies and scripts
├── package-lock.json   # npm dependency lockfile
├── vite.config.ts      # Vite configuration
├── tsconfig.json       # TypeScript configuration
└── README.md           # Project documentation
```

Server-side functions and API integrations should be located wherever the current application architecture defines them. Do not assume that a particular endpoint or file exists unless it is present in the repository.

## 🔐 Security

Security is essential because SACHSCAN may handle private evidence and paid analysis workflows.

Recommended practices:

- Keep `.env` files out of version control.
- Store external API secrets on the server.
- Validate and sanitize user inputs.
- Enforce file type and size restrictions.
- Configure Supabase RLS and authentication checks.
- Verify payment authorization server-side.
- Avoid returning sensitive credentials or internal errors to the client.
- Apply appropriate rate limits to expensive analysis endpoints.
- Avoid logging private evidence or API secrets.
- Rotate credentials immediately if they are accidentally exposed.

Example `.gitignore` entries:

```gitignore
node_modules/
dist/
.env
.env.*
!.env.example
.vercel/
```

Review the existing `.gitignore` before modifying it so that required project files remain included.

## 🧪 Testing and Verification

Before deploying or demonstrating the application, verify:

- The application starts successfully.
- Required environment variables are configured.
- Supabase access policies behave as intended.
- Evidence uploads respect supported file types and size limits.
- TinyFish requests handle empty results and API errors.
- AI analysis results are presented with appropriate limitations.
- Payment-gated features reject unauthorized requests.
- x402 payment flows use the intended Algorand Testnet configuration.
- No private API credentials appear in frontend bundles or public Git history.

## ⚠️ Limitations

- AI detectors can produce false positives and false negatives.
- Source discovery may miss relevant pages or return incomplete information.
- A source URL is not proof of original ownership or authenticity.
- Metadata may be missing, modified, or stripped from a file.
- Results depend on external API availability, access permissions, and service limits.
- Blockchain payment demonstrations depend on network and facilitator availability.

SACHSCAN should be used as a decision-support and investigation tool. Important findings should be independently verified before being treated as evidence.

## 🔮 Future Scope

Potential improvements include:

- Stronger source-correlation workflows.
- Better evidence provenance and investigation timelines.
- More comprehensive media-forensics integrations.
- Improved result explanations and confidence reporting.
- More robust audit logging.
- Expanded payment and access-control options.
- Additional support for evidence formats and investigative workflows.

These are potential improvements, not claims that every feature is currently implemented.

## 🤝 Contributing

Contributions, bug reports, and suggestions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make and test your changes.
4. Submit a pull request describing the changes.

Please do not include API credentials, private evidence, or sensitive user information in issues or pull requests.

## 📜 License

Choose and add a license before distributing this project for reuse. Until a license is included in the repository, do not assume that others have permission to reuse, modify, or redistribute the code.

---

**SACHSCAN** — Investigate digital content. Discover sources. Review evidence responsibly.
