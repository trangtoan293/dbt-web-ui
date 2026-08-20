"""
Test script for dbt-runner concurrency features.
Tests: Redis connection, Session Lock, File Lock, Session ID handling
"""
import asyncio
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

async def test_redis_connection():
    """Test 1: Redis connection"""
    print("\n" + "="*50)
    print("TEST 1: Redis Connection")
    print("="*50)
    
    try:
        from app.core.redis_client import get_redis, check_redis_health
        
        health = await check_redis_health()
        if health:
            print("✅ Redis health check: PASSED")
        else:
            print("❌ Redis health check: FAILED")
            return False
            
        redis = await get_redis()
        await redis.set("test_key", "test_value")
        value = await redis.get("test_key")
        
        if value == "test_value":
            print("✅ Redis get/set: PASSED")
        else:
            print(f"❌ Redis get/set: FAILED (got {value})")
            return False
            
        await redis.delete("test_key")
        return True
        
    except Exception as e:
        print(f"❌ Redis test failed: {e}")
        return False

async def test_session_lock():
    """Test 2: Session Lock Service"""
    print("\n" + "="*50)
    print("TEST 2: Session Lock Service")
    print("="*50)
    
    try:
        from app.services.session_lock import SessionLockService
        
        project_id = "test-project-123"
        session_a = "session-aaa-111"
        session_b = "session-bbb-222"
        
        # Test 1: Acquire lock
        result = await SessionLockService.acquire_project_lock(project_id, session_a)
        if result["acquired"]:
            print("✅ Lock acquired by session A: PASSED")
        else:
            print("❌ Lock acquire failed")
            return False
        
        # Test 2: Same session can refresh lock
        result = await SessionLockService.acquire_project_lock(project_id, session_a)
        if result["acquired"]:
            print("✅ Same session can refresh lock: PASSED")
        else:
            print("❌ Same session lock refresh failed")
            return False
        
        # Test 3: Different session should be blocked
        try:
            await SessionLockService.acquire_project_lock(project_id, session_b)
            print("❌ Different session should be blocked: FAILED")
            return False
        except Exception as e:
            if "423" in str(e.status_code) or "locked" in str(e.detail).lower():
                print("✅ Different session blocked (HTTP 423): PASSED")
            else:
                print(f"❌ Unexpected error: {e}")
                return False
        
        # Test 4: Check lock status
        status = await SessionLockService.get_lock_status(project_id, session_a)
        if status["is_locked"] and status["is_owned_by_current_session"]:
            print("✅ Lock status check: PASSED")
        else:
            print(f"❌ Lock status check failed: {status}")
            return False
        
        # Test 5: Release lock
        released = await SessionLockService.release_project_lock(project_id, session_a)
        if released:
            print("✅ Lock release: PASSED")
        else:
            print("❌ Lock release failed")
            return False
        
        # Cleanup
        await SessionLockService.force_release_lock(project_id)
        return True
        
    except Exception as e:
        print(f"❌ Session lock test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_file_lock():
    """Test 3: Async File Lock"""
    print("\n" + "="*50)
    print("TEST 3: Async File Lock")
    print("="*50)
    
    try:
        from app.core.file_lock import AsyncFileLock
        
        project_id = "test-project-456"
        
        # Test 1: Acquire and release lock
        async with AsyncFileLock.lock(project_id, "dbt_run"):
            print("✅ File lock acquired: PASSED")
            
            # Check if locked
            is_locked = await AsyncFileLock.is_locked(project_id, "dbt_run")
            if is_locked:
                print("✅ Lock status during hold: PASSED")
            else:
                print("❌ Lock should show as held")
                return False
        
        # After context manager, lock should be released
        is_locked = await AsyncFileLock.is_locked(project_id, "dbt_run")
        if not is_locked:
            print("✅ Lock auto-release after context: PASSED")
        else:
            print("❌ Lock should be released after context")
            return False
        
        # Test 2: Concurrent locks queue properly
        print("Testing concurrent lock queueing...")
        results = []
        
        async def worker(worker_id: int):
            async with AsyncFileLock.lock(project_id, "queue_test"):
                results.append(worker_id)
                await asyncio.sleep(0.1)  # Simulate work
        
        # Start multiple workers
        await asyncio.gather(
            worker(1),
            worker(2),
            worker(3)
        )
        
        if len(results) == 3:
            print(f"✅ All workers completed (order: {results}): PASSED")
        else:
            print(f"❌ Expected 3 workers, got {len(results)}")
            return False
        
        # Cleanup
        await AsyncFileLock.force_release(project_id, "dbt_run")
        await AsyncFileLock.force_release(project_id, "queue_test")
        return True
        
    except Exception as e:
        print(f"❌ File lock test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_session_middleware():
    """Test 4: Session Middleware"""
    print("\n" + "="*50)
    print("TEST 4: Session Middleware")
    print("="*50)
    
    try:
        from app.core.session_middleware import get_session_id
        from unittest.mock import MagicMock
        import uuid
        
        # Create mock request
        mock_request = MagicMock()
        mock_request.state = MagicMock()
        mock_request.state.session_id = "test-session-xyz"
        
        session_id = get_session_id(mock_request)
        if session_id == "test-session-xyz":
            print("✅ Get session from request: PASSED")
        else:
            print(f"❌ Expected test-session-xyz, got {session_id}")
            return False
        
        # Test without session (should generate new)
        mock_request.state = MagicMock(spec=[])  # No session_id attr
        session_id = get_session_id(mock_request)
        try:
            uuid.UUID(session_id)
            print("✅ Generate new UUID for missing session: PASSED")
        except ValueError:
            print(f"❌ Generated invalid UUID: {session_id}")
            return False
        
        return True
        
    except Exception as e:
        print(f"❌ Session middleware test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_config():
    """Test 5: Config Settings"""
    print("\n" + "="*50)
    print("TEST 5: Config Settings")
    print("="*50)
    
    try:
        from app.config import settings
        
        # Check new settings exist
        checks = [
            ("redis_url", settings.redis_url),
            ("session_lock_ttl", settings.session_lock_ttl),
            ("file_lock_ttl", settings.file_lock_ttl),
            ("file_lock_wait_timeout", settings.file_lock_wait_timeout),
            ("max_concurrent_commands_per_project", settings.max_concurrent_commands_per_project),
        ]
        
        for name, value in checks:
            if value is not None:
                print(f"✅ {name}: {value}")
            else:
                print(f"❌ {name} is None")
                return False
        
        return True
        
    except Exception as e:
        print(f"❌ Config test failed: {e}")
        return False

async def run_all_tests():
    """Run all tests"""
    print("\n" + "#"*60)
    print("# dbt-runner Concurrency Features Test Suite")
    print("#"*60)
    
    results = {}
    
    # Run tests
    results["Config"] = await test_config()
    results["Redis Connection"] = await test_redis_connection()
    results["Session Lock"] = await test_session_lock()
    results["File Lock"] = await test_file_lock()
    results["Session Middleware"] = await test_session_middleware()
    
    # Summary
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    
    passed = 0
    failed = 0
    
    for test_name, result in results.items():
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"  {test_name}: {status}")
        if result:
            passed += 1
        else:
            failed += 1
    
    print(f"\nTotal: {passed} passed, {failed} failed")
    
    # Cleanup Redis
    try:
        from app.core.redis_client import close_redis
        await close_redis()
    except:
        pass
    
    return failed == 0

if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
