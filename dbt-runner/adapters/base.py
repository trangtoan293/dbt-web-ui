"""
Base adapter class for database connections.
Mirrors the TypeScript extractor pattern from dbt-craft-sample/src/main/extractor/
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, asdict


@dataclass
class Column:
    """Represents a database column."""
    name: str
    type_name: str
    ordinal_position: int
    nullable: bool
    primary_key: bool = False
    autoincrement: bool = False
    column_display_size: int = 0
    scale: int = 0
    precision: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Table:
    """Represents a database table or view."""
    name: str
    type: str  # 'TABLE' or 'VIEW'
    schema: str
    columns: List[Column]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type,
            "schema": self.schema,
            "columns": [col.to_dict() for col in self.columns]
        }


class BaseAdapter(ABC):
    """
    Abstract base class for database adapters.
    
    Each adapter must implement:
    - connect() / disconnect() - connection lifecycle
    - test_connection() - verify connection is valid
    - extract_schema() - get tables and columns
    - generate_profiles_yml() - create dbt profiles.yml content
    
    This mirrors the TypeScript extractor pattern:
    - pg.extractor.ts
    - duckdb.extractor.ts
    - snowflake.extractor.ts
    - etc.
    """
    
    adapter_type: str = ""
    
    def __init__(self, config: Dict[str, Any]):
        """
        Initialize adapter with connection config.
        
        Config structure varies by adapter type:
        - postgresql: {host, port, user, password, dbname, schema}
        - duckdb: {path, schema, extensions}
        - dremio: {host, port, pat, is_cloud, dremio_space, ...}
        """
        self.config = config
        self._connection = None
    
    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to the database."""
        pass
    
    @abstractmethod
    async def disconnect(self) -> None:
        """Close the database connection."""
        pass
    
    @abstractmethod
    async def test_connection(self) -> Dict[str, Any]:
        """
        Test if connection is valid.
        
        Returns:
            {
                "success": bool,
                "message": str,
                "details": Optional[Dict] - additional info like version
            }
        """
        pass
    
    @abstractmethod
    async def extract_schema(self) -> Dict[str, List[Table]]:
        """
        Extract schema metadata from database.
        
        Returns:
            {"tables": List[Table]}
        """
        pass
    
    @abstractmethod
    def generate_profiles_yml(self, project_name: str, target: str = "dev") -> str:
        """
        Generate dbt profiles.yml content for this connection type.
        
        Args:
            project_name: Name of the dbt project
            target: Target environment (default: "dev")
            
        Returns:
            YAML string for profiles.yml
        """
        pass
    
    # Internal helper methods (to be implemented by subclasses)
    @abstractmethod
    async def _get_schemas(self) -> List[str]:
        """Get list of schemas in the database."""
        pass
    
    @abstractmethod
    async def _get_tables(self, schema: str) -> List[str]:
        """Get list of tables in a schema."""
        pass
    
    @abstractmethod
    async def _get_views(self, schema: str) -> List[str]:
        """Get list of views in a schema."""
        pass
    
    @abstractmethod
    async def _get_columns(self, schema: str, table: str) -> List[Column]:
        """Get columns for a table/view."""
        pass
    
    def get_config_value(self, key: str, default: Any = None) -> Any:
        """Safely get a config value with default."""
        return self.config.get(key, default)
