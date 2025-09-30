# CloudDrive Backend

A Node.js/Express backend API for a cloud storage application with file upload, sharing, and user management features.

## Features

- User authentication (register/login) with JWT
- File upload and download
- File sharing with permissions (view/edit)
- Supabase integration for database and storage
- TypeScript support
- RESTful API design

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: Supabase (PostgreSQL)
- **Storage**: Supabase Storage
- **Authentication**: JWT tokens
- **File Upload**: Multer

## Project Structure

```
backend/
├── src/
│   ├── lib/
│   │   └── supabase.ts       # Supabase client initialization
│   ├── routes/
│   │   ├── auth.ts           # Authentication endpoints
│   │   ├── files.ts          # File operations endpoints
│   │   └── shares.ts         # File sharing endpoints
│   ├── middlewares/
│   │   └── auth.ts           # JWT authentication middleware
│   ├── utils/
│   │   └── helpers.ts        # Utility functions
│   └── server.ts             # Main Express server
├── .env                      # Environment variables
├── .env.example             # Environment variables template
├── package.json
├── tsconfig.json
└── README.md
```

## Setup Instructions

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Supabase account and project

### Installation

1. Clone the repository and navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your actual values (see .env.example for all variables):
   ```
   PORT=4000
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   JWT_SECRET=your_jwt_secret_key_here
   CLIENT_URL=http://localhost:5173
   # ... and other variables
   ```

4. Set up Supabase database tables:

   Create the following tables in your Supabase project:

   ```sql
   -- Users table
   CREATE TABLE users (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     email VARCHAR(255) UNIQUE NOT NULL,
     password VARCHAR(255) NOT NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );

   -- Files table
   CREATE TABLE files (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     user_id UUID REFERENCES users(id) ON DELETE CASCADE,
     name VARCHAR(255) NOT NULL,
     size BIGINT NOT NULL,
     type VARCHAR(255) NOT NULL,
     path VARCHAR(500) NOT NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );

   -- Shares table
   CREATE TABLE shares (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     file_id UUID REFERENCES files(id) ON DELETE CASCADE,
     user_id UUID REFERENCES users(id) ON DELETE CASCADE,
     shared_with_email VARCHAR(255) NOT NULL,
     permissions VARCHAR(50) CHECK (permissions IN ('view', 'edit')),
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
   ```

5. Set up Supabase Storage:

   Create a storage bucket named `files` with appropriate policies for file uploads and downloads.

### Running the Application

#### Development mode:
```bash
npm run dev
```

#### Production build:
```bash
npm run build
npm start
```

The server will start on `http://localhost:4000` by default.

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login user

### Files

- `POST /api/files/upload` - Upload a file (requires auth)
- `GET /api/files` - List user's files (requires auth)
- `DELETE /api/files/:id` - Delete a file (requires auth)
- `GET /api/files/:id/download` - Get download URL for a file (requires auth)

### Shares

- `POST /api/shares/:fileId/share` - Share a file with another user (requires auth)
- `GET /api/shares/shared-with-me` - Get files shared with current user (requires auth)
- `GET /api/shares/shared-by-me` - Get files shared by current user (requires auth)
- `DELETE /api/shares/:fileId/shares/:shareId` - Revoke a file share (requires auth)

### Health Check

- `GET /api/health` - Check server status

## Usage Examples

### Register a new user:
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password123"}'
```

### Upload a file:
```bash
curl -X POST http://localhost:4000/api/files/upload \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@/path/to/your/file.pdf"
```

### Share a file:
```bash
curl -X POST http://localhost:4000/api/shares/FILE_ID/share \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "friend@example.com", "permissions": "view"}'
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port | No (defaults to 4000) |
| `NODE_ENV` | Environment (development/production) | No |
| `CLIENT_URL` | Frontend URL for CORS | Yes |
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Yes |
| `JWT_SECRET` | Secret key for JWT signing | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Optional |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Yes for OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Yes for OAuth |
| `STRIPE_SECRET_KEY` | Stripe secret key | Yes for payments |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | Yes for payments |
| `STRIPE_PRICE_ID_PRO` | Stripe price ID for Pro plan | Yes for payments |
| `STRIPE_PRICE_ID_BUSINESS` | Stripe price ID for Business plan | Yes for payments |

## Development

### Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm test` - Run tests (not implemented yet)

### Code Structure

- **Routes**: Handle HTTP requests and responses
- **Middlewares**: Process requests before reaching routes
- **Utils**: Helper functions and utilities
- **Lib**: External service integrations (Supabase)

## Security Features

- JWT-based authentication
- Password hashing with bcrypt
- File type validation
- File size limits
- CORS configuration
- Input validation and sanitization

## Deployment

### Backend (Render)

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Set build settings:
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
4. Set environment variables in Render dashboard (see .env.example)
5. For production, set:
   - `NODE_ENV=production`
   - `CLIENT_URL=https://your-vercel-app.vercel.app`
   - Update webhook URLs in Stripe and Google Console to point to your Render URL

### Frontend (Vercel)

1. Create a new project on Vercel
2. Connect your GitHub repository (frontend folder)
3. Set environment variable:
   - `VITE_API_BASE_URL=https://your-render-app.onrender.com/api`
4. Deploy

### Additional Setup

- **Google OAuth**: Add your Vercel domain to authorized redirect URIs and JavaScript origins in Google Console
- **Stripe Webhooks**: Update webhook endpoint to `https://your-render-app.onrender.com/api/billing/webhook`
- **Supabase**: Ensure CORS settings allow your production domains

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

ISC
