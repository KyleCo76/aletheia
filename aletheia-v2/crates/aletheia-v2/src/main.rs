use clap::Parser;

#[derive(Parser)]
#[command(
    name = "aletheia-v2",
    version,
    about = "Aletheia V2 — structured memory MCP server"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(clap::Subcommand)]
enum Commands {
    /// Run the MCP server (default mode)
    Serve,
    /// First-time installation setup
    Setup,
    /// Migrate from V1 (one-shot, master-key required)
    MigrateFromV1 {
        /// Path to the V1 SQLite database file
        v1_db_path: std::path::PathBuf,
    },
}

fn main() -> aletheia_v2::error::Result<()> {
    aletheia_v2::init_tracing();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Commands::Serve) {
        Commands::Serve => unimplemented!("Phase 4"),
        Commands::Setup => unimplemented!("Phase 3"),
        Commands::MigrateFromV1 { .. } => unimplemented!("Phase 8"),
    }
}
